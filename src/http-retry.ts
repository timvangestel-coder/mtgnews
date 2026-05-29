export interface RetryConfig {
  maxRetries?: number;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
const BASE_DELAY_MS = 1000;

/** @internal — overridable in tests to avoid real timer waits */
let _delay: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function __setDelay(fn: typeof _delay): void {
  _delay = fn;
}

function isTransientError(error: unknown): boolean {
  if (error instanceof TypeError) {
    return true;
  }
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED');
}

function jitterDelay(attempt: number): number {
  const exponential = BASE_DELAY_MS * Math.pow(2, attempt - 1);
  const jitter = Math.random() * exponential * 0.5;
  return exponential + jitter;
}

export async function fetchWithRetry(
  url: string | Request,
  options?: RequestInit,
  config?: RetryConfig
): Promise<Response> {
  const maxRetries = config?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const externalSignal = config?.abortSignal;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    // Check if externally aborted before attempting
    if (externalSignal?.aborted) {
      throw externalSignal.reason || new Error('Aborted by caller');
    }

    try {
      // Create internal timeout controller
      const internal = new AbortController();
      const timeoutId = setTimeout(() => internal.abort(), timeoutMs);

      // Merge external abort signal with internal timeout
      let mySignal: AbortSignal = internal.signal;
      if (externalSignal) {
        const combined = new AbortController();
        const onExternal = () => combined.abort(externalSignal?.reason ?? new Error('Aborted by caller'));
        externalSignal.addEventListener('abort', onExternal, { once: true });
        if (externalSignal.aborted) {
          combined.abort(externalSignal.reason);
        }
        mySignal = combined.signal;
      }

      const response = await fetch(url, { ...options, signal: mySignal });
      clearTimeout(timeoutId);

      // HTTP responses (even error status codes) are passed through without retry
      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Abort errors (timeout or external) — do not retry
      if (lastError.name === 'AbortError') {
        throw lastError;
      }

      // Only retry on transient network errors
      if (!isTransientError(lastError) || attempt >= maxRetries + 1) {
        throw lastError;
      }

      // Wait with exponential backoff + jitter before retry
      const delayMs = jitterDelay(attempt);
      await _delay(delayMs);
    }
  }

  throw lastError ?? new Error('All retries exhausted');
}