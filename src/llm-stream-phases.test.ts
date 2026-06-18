import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { callLlmStreamWithPhases, LlmConfig, LlmStreamOptions } from './llm';
import { LlmPhase } from './phase-registry.ts';

const mockFetch = vi.fn();
const originalFetch = global.fetch;

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.stubGlobal('fetch', originalFetch);
});

const config: LlmConfig = {
  endpoint: 'http://127.0.0.1:1234/v1/chat/completions',
  model: 'qwen/qwen3.6-27b',
};

function mockSseResponse(chunks: string[]) {
  const encoder = new TextEncoder();

  const readable = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  mockFetch.mockResolvedValueOnce({
    ok: true,
    body: readable,
  } as any);
}

describe('callLlmStreamWithPhases', () => {
  it('fires intake callback at request-send time with tokenCount=0', async () => {
    const phases: LlmPhase[] = [];
    const counts: number[] = [];

    mockSseResponse([
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ]);

    const options: LlmStreamOptions = {
      onPhaseChange: (phase, tokenCount) => {
        phases.push(phase);
        counts.push(tokenCount);
      },
    };

    for await (const _token of callLlmStreamWithPhases(config, 'test prompt', options)) {
      // consume generator
    }

    expect(phases).toContain('intake');
    const intakeIndex = phases.indexOf('intake');
    expect(counts[intakeIndex]).toBe(0);
  });

  it('fires reasoning when first SSE chunk has delta.reasoning_content', async () => {
    const phases: LlmPhase[] = [];
    const counts: number[] = [];

    mockSseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"thinking about this"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ]);

    const options: LlmStreamOptions = {
      onPhaseChange: (phase, tokenCount) => {
        phases.push(phase);
        counts.push(tokenCount);
      },
    };

    for await (const _token of callLlmStreamWithPhases(config, 'test prompt', options)) {
      // consume generator
    }

    expect(phases).toContain('reasoning');
  });

  it('fires answering when SSE chunks switch to delta.content after reasoning, passing cumulative reasoning token count', async () => {
    const phases: LlmPhase[] = [];
    const counts: number[] = [];

    mockSseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":" more thinking"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ]);

    const options: LlmStreamOptions = {
      onPhaseChange: (phase, tokenCount) => {
        phases.push(phase);
        counts.push(tokenCount);
      },
    };

    for await (const _token of callLlmStreamWithPhases(config, 'test prompt', options)) {
      // consume generator
    }

    expect(phases).toContain('answering');
    const answeringIndex = phases.indexOf('answering');
    // token count at answering should include reasoning tokens
    expect(counts[answeringIndex]).toBeGreaterThan(0);
  });

  it('fires done on finish_reason stop with total token count (reasoning + content)', async () => {
    const phases: LlmPhase[] = [];
    const counts: number[] = [];

    mockSseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ]);

    const options: LlmStreamOptions = {
      onPhaseChange: (phase, tokenCount) => {
        phases.push(phase);
        counts.push(tokenCount);
      },
    };

    for await (const _token of callLlmStreamWithPhases(config, 'test prompt', options)) {
      // consume generator
    }

    expect(phases).toContain('done');
    const doneIndex = phases.indexOf('done');
    // done should have cumulative token count from reasoning + content
    expect(counts[doneIndex]).toBeGreaterThan(0);
  });

  it('generator yields only content tokens, never reasoning_content', async () => {
    mockSseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"internal thought"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"public answer"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ]);

    const options: LlmStreamOptions = {
      onPhaseChange: () => {},
    };

    const tokens: string[] = [];
    for await (const token of callLlmStreamWithPhases(config, 'test prompt', options)) {
      tokens.push(token);
    }

    expect(tokens).toEqual(['public answer']);
    expect(tokens).not.toContain('internal thought');
  });

  it('verifies cumulative token counting across phases', async () => {
    const counts: number[] = [];

    mockSseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"aaa"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"bbb"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"ccc"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"ddd"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ]);

    const options: LlmStreamOptions = {
      onPhaseChange: (_phase, tokenCount) => {
        counts.push(tokenCount);
      },
    };

    for await (const _token of callLlmStreamWithPhases(config, 'test prompt', options)) {
      // consume generator
    }

    // Token count should be monotonically increasing across phases
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
    }
  });

  it('fires all four phase transitions in correct order', async () => {
    const phases: LlmPhase[] = [];

    mockSseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ]);

    const options: LlmStreamOptions = {
      onPhaseChange: (phase) => {
        phases.push(phase);
      },
    };

    for await (const _token of callLlmStreamWithPhases(config, 'test prompt', options)) {
      // consume generator
    }

    expect(phases).toEqual(['intake', 'reasoning', 'answering', 'done']);
  });

  it('works without onPhaseChange callback (backward compat)', async () => {
    mockSseResponse([
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ]);

    const tokens: string[] = [];
    for await (const token of callLlmStreamWithPhases(config, 'test prompt')) {
      tokens.push(token);
    }

    expect(tokens).toEqual(['hello']);
  });

  it('fires intake and done with no reasoning phase when only content', async () => {
    const phases: LlmPhase[] = [];

    mockSseResponse([
      'data: {"choices":[{"delta":{"content":"direct answer"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ]);

    const options: LlmStreamOptions = {
      onPhaseChange: (phase) => {
        phases.push(phase);
      },
    };

    for await (const _token of callLlmStreamWithPhases(config, 'test prompt', options)) {
      // consume generator
    }

    expect(phases).toEqual(['intake', 'answering', 'done']);
  });

  it('supports abortSignal for cancellation', async () => {
    const controller = new AbortController();
    controller.abort();

    mockFetch.mockImplementation(() => {
      throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    });

    const gen = callLlmStreamWithPhases(config, 'prompt', { abortSignal: controller.signal });
    let error;
    try {
      await gen.next();
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect((error as Error).message.toLowerCase()).toMatch(/abort/i);
  });
});