import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { callLlmStreamWithPhases, LlmConfig, LlmStreamOptions } from './llm';

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

describe('callLlmStreamWithPhases - continuous token count updates', () => {
  it('fires onPhaseChange with updated tokenCount for each reasoning chunk', async () => {
    const calls: Array<{ phase: string; tokenCount: number }> = [];

    mockSseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"aaa"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"bbb"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"ccc"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ]);

    const options: LlmStreamOptions = {
      onPhaseChange: (phase, tokenCount) => {
        calls.push({ phase, tokenCount });
      },
    };

    for await (const _token of callLlmStreamWithPhases(config, 'test prompt', options)) {
      // consume generator
    }

    // Filter to reasoning-phase calls only
    const reasoningCalls = calls.filter(c => c.phase === 'reasoning');

    // Should fire on every reasoning chunk, not just the first one
    expect(reasoningCalls.length).toBe(3);

    // Each SSE delta = one token: counts 1, 2, 3
    expect(reasoningCalls[0].tokenCount).toBe(1);
    expect(reasoningCalls[1].tokenCount).toBe(2);
    expect(reasoningCalls[2].tokenCount).toBe(3);
  });

  it('fires onPhaseChange with updated tokenCount for each content chunk', async () => {
    const calls: Array<{ phase: string; tokenCount: number }> = [];

    mockSseResponse([
      'data: {"choices":[{"delta":{"content":"aaa"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"bbb"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"ccc"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ]);

    const options: LlmStreamOptions = {
      onPhaseChange: (phase, tokenCount) => {
        calls.push({ phase, tokenCount });
      },
    };

    for await (const _token of callLlmStreamWithPhases(config, 'test prompt', options)) {
      // consume generator
    }

    // Filter to answering-phase calls only
    const answeringCalls = calls.filter(c => c.phase === 'answering');

    // Should fire on every content chunk, not just the first one
    expect(answeringCalls.length).toBe(3);

    // Each SSE delta = one token: counts 1, 2, 3
    expect(answeringCalls[0].tokenCount).toBe(1);
    expect(answeringCalls[1].tokenCount).toBe(2);
    expect(answeringCalls[2].tokenCount).toBe(3);
  });

  it('accumulates reasoning + content tokens across phase transition with continuous updates', async () => {
    const calls: Array<{ phase: string; tokenCount: number }> = [];

    mockSseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"aa"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"bb"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"cc"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"dd"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ]);

    const options: LlmStreamOptions = {
      onPhaseChange: (phase, tokenCount) => {
        calls.push({ phase, tokenCount });
      },
    };

    for await (const _token of callLlmStreamWithPhases(config, 'test prompt', options)) {
      // consume generator
    }

    // reasoning: 2 chunks = 2 tokens: counts 1, 2
    const reasoningCalls = calls.filter(c => c.phase === 'reasoning');
    expect(reasoningCalls.length).toBe(2);
    expect(reasoningCalls[0].tokenCount).toBe(1);
    expect(reasoningCalls[1].tokenCount).toBe(2);

    // answering: 2 more chunks = cumulative counts 3, 4
    const answeringCalls = calls.filter(c => c.phase === 'answering');
    expect(answeringCalls.length).toBe(2);
    expect(answeringCalls[0].tokenCount).toBe(3);
    expect(answeringCalls[1].tokenCount).toBe(4);

    // done: no usage in final chunk, falls back to chunk count (4)
    const doneCalls = calls.filter(c => c.phase === 'done');
    expect(doneCalls.length).toBe(1);
    expect(doneCalls[0].tokenCount).toBe(4);
  });
});