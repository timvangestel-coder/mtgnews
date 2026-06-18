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

describe('callLlmStreamWithPhases - token count accuracy (issue #160)', () => {
  it('sends stream_options: { include_usage: true } in request body', async () => {
    mockSseResponse([
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ]);

    for await (const _token of callLlmStreamWithPhases(config, 'test prompt')) {
      // consume generator
    }

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('uses usage.completion_tokens from final chunk for done phase', async () => {
    const calls: Array<{ phase: string; tokenCount: number }> = [];

    // Simulate a realistic stream: reasoning chunks, content chunks, then final chunk with usage
    mockSseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"some reasoning text here"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"answer part one"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"answer part two"}}]}\n\n',
      // Final chunk with finish_reason AND usage (stream_options include_usage)
      'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":500,"completion_tokens":42,"total_tokens":542}}\n\n',
    ]);

    const options: LlmStreamOptions = {
      onPhaseChange: (phase, tokenCount) => {
        calls.push({ phase, tokenCount });
      },
    };

    for await (const _token of callLlmStreamWithPhases(config, 'test prompt', options)) {
      // consume generator
    }

    const doneCalls = calls.filter(c => c.phase === 'done');
    expect(doneCalls.length).toBe(1);
    // Must use actual LLM-reported token count (42), NOT character length
    expect(doneCalls[0].tokenCount).toBe(42);
  });

  it('counts chunks during streaming, then corrects to actual usage at done', async () => {
    const calls: Array<{ phase: string; tokenCount: number }> = [];

    mockSseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"aaaaaaaaaa"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"bbbbbbbbbb"}}]}\n\n',
      // Final chunk with usage: actual completion_tokens=5 (not 2 chunks)
      'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":5,"total_tokens":105}}\n\n',
    ]);

    const options: LlmStreamOptions = {
      onPhaseChange: (phase, tokenCount) => {
        calls.push({ phase, tokenCount });
      },
    };

    for await (const _token of callLlmStreamWithPhases(config, 'test prompt', options)) {
      // consume generator
    }

    const reasoningCalls = calls.filter(c => c.phase === 'reasoning');
    const answeringCalls = calls.filter(c => c.phase === 'answering');
    const doneCalls = calls.filter(c => c.phase === 'done');

    // Intermediate phases fire with chunk counts (each SSE delta = 1 token)
    expect(reasoningCalls.length).toBe(1);
    expect(reasoningCalls[0].tokenCount).toBe(1);
    expect(answeringCalls.length).toBe(1);
    expect(answeringCalls[0].tokenCount).toBe(2);

    // Done phase uses actual LLM token count from usage (5), overriding chunk count (2)
    expect(doneCalls.length).toBe(1);
    expect(doneCalls[0].tokenCount).toBe(5);
  });

  it('uses reasoning_tokens from usage details when available', async () => {
    const calls: Array<{ phase: string; tokenCount: number }> = [];

    mockSseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"thinking about this"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"the answer is 42"}}]}\n\n',
      // Final chunk with detailed usage
      'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":30,"total_tokens":130,"completion_tokens_details":{"reasoning_tokens":18}}}\n\n',
    ]);

    const options: LlmStreamOptions = {
      onPhaseChange: (phase, tokenCount) => {
        calls.push({ phase, tokenCount });
      },
    };

    for await (const _token of callLlmStreamWithPhases(config, 'test prompt', options)) {
      // consume generator
    }

    const doneCalls = calls.filter(c => c.phase === 'done');
    expect(doneCalls.length).toBe(1);
    // completion_tokens=30 is the total output tokens (reasoning + content)
    expect(doneCalls[0].tokenCount).toBe(30);
  });

  it('falls back to chunk count when usage not present in final chunk', async () => {
    const calls: Array<{ phase: string; tokenCount: number }> = [];

    // Some LLMs may not return usage even with stream_options
    mockSseResponse([
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
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

    const doneCalls = calls.filter(c => c.phase === 'done');
    expect(doneCalls.length).toBe(1);
    // Without usage, fall back to chunk count (2 content chunks = 2 tokens)
    expect(doneCalls[0].tokenCount).toBe(2);
  });
});