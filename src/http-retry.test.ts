import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fetchWithRetry, __setDelay } from './http-retry';

const mockFetch = vi.fn();
const originalFetch = global.fetch;

let delayCalls: number[] = [];

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
  delayCalls = [];
  // Inject instant delay for tests (real timers via fakeTimers for timeout)
  __setDelay((ms) => {
    delayCalls.push(ms);
    return Promise.resolve();
  });
});

afterEach(() => {
  vi.stubGlobal('fetch', originalFetch);
  // Restore real delay
  __setDelay((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
});

describe('fetchWithRetry', () => {
  it('returns Response on first successful fetch', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const result = await fetchWithRetry('http://example.com/api', { method: 'POST' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it('times out and throws when fetch exceeds timeoutMs', async () => {
    // Mock fetch that respects abort signal — rejects when signal fires
    mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        const signal = opts?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }
      });
    });

    await expect(
      fetchWithRetry('http://example.com/slow', {}, { timeoutMs: 10 })
    ).rejects.toThrow();
  }, 5000);

  it('honors external abort signal and cancels mid-retry', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));

    const ctrl = new AbortController();

    // Pre-abort the signal before calling
    ctrl.abort();

    await expect(
      fetchWithRetry('http://example.com/', {}, { abortSignal: ctrl.signal, maxRetries: 3 })
    ).rejects.toThrow();

    // Should have made zero attempts (aborted before first)
    expect(mockFetch).toHaveBeenCalledTimes(0);
  });

  it('cancels during retry wait when external signal fires', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));

    const ctrl = new AbortController();

    // Use a delay that aborts synchronously on first call
    let delayCount = 0;
    __setDelay((ms) => {
      delayCount++;
      if (delayCount === 1) {
        // Fire abort immediately — next loop iteration will see aborted signal
        ctrl.abort();
      }
      return Promise.resolve();
    });

    const promise = fetchWithRetry('http://example.com/', {}, {
      abortSignal: ctrl.signal,
      maxRetries: 5,
    });

    await expect(promise).rejects.toThrow();

    // Only 1 attempt made (aborted before retry 2)
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on TypeError and returns response when retry succeeds', async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const result = await fetchWithRetry('http://example.com/', {}, { maxRetries: 2 });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    // One delay was called (between attempt 1 and 2)
    expect(delayCalls.length).toBe(1);
    expect(delayCalls[0]).toBeGreaterThanOrEqual(1000); // base delay >= BASE_DELAY_MS
  });

  it('retries on ECONNRESET error', async () => {
    const err = new Error('ECONNRESET');
    mockFetch
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const result = await fetchWithRetry('http://example.com/', {}, { maxRetries: 1 });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
  });

  it('retries on ECONNREFUSED error', async () => {
    const err = new Error('connect ECONNREFUSED');
    mockFetch
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const result = await fetchWithRetry('http://example.com/', {}, { maxRetries: 1 });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
  });

  it('does NOT retry on HTTP error responses (passes through)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' });

    const result = await fetchWithRetry('http://example.com/', {}, { maxRetries: 3 });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
  });

  it('does NOT retry on 4xx responses', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });

    const result = await fetchWithRetry('http://example.com/', {}, { maxRetries: 3 });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(404);
  });

  it('uses exponential backoff between retries', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));

    await expect(
      fetchWithRetry('http://example.com/', {}, { maxRetries: 2 })
    ).rejects.toThrow();

    // 1 initial + 2 retries = 3 calls, 2 delays between them
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(delayCalls.length).toBe(2);
    // First delay ~1000ms base, second ~2000ms base (with jitter added)
    expect(delayCalls[0]).toBeGreaterThanOrEqual(1000);
    expect(delayCalls[1]).toBeGreaterThanOrEqual(2000);
  });

  it('exhausts retries and throws last error when all fail', async () => {
    mockFetch.mockRejectedValue(new TypeError('network down'));

    await expect(
      fetchWithRetry('http://example.com/', {}, { maxRetries: 2 })
    ).rejects.toThrow('network down');

    // 1 initial + 2 retries = 3 calls
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('has no LLM-specific terminology in exports', async () => {
    expect(fetchWithRetry).toBeDefined();
    const name = (fetchWithRetry as Function).name;
    expect(name).not.toContain('llm');
    expect(name).not.toContain('Llm');
    expect(name).not.toContain('LLM');
  });
});