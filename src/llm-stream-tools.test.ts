import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { callLlmStreamWithTools, LlmConfig, LlmStreamOptions } from './llm';
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

describe('callLlmStreamWithTools', () => {
  it('fires retrieving phase when tool_calls are detected in SSE delta', async () => {
    const phases: LlmPhase[] = [];

    mockSseResponse([
      'data: {"choices":[{"delta":{"content":"Let me check"}}]}\n\n',
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"get_weather","arguments":"{\\\"city\\\":\\\"London\\\"}"}}]}}]}\n\n`,
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ]);

    const options: LlmStreamOptions = {
      onPhaseChange: (phase) => {
        phases.push(phase);
      },
    };

    const result = await callLlmStreamWithTools(config, 'What is the weather in London?', [{ type: 'function', function: { name: 'get_weather', parameters: {} } }], options);
    for await (const _ of result.tokens) { /* consume stream to trigger phases */ }

    expect(phases).toContain('retrieving');
  });

  it('yields content tokens from SSE stream', async () => {
    mockSseResponse([
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ]);

    const tokens: string[] = [];
    const result = await callLlmStreamWithTools(config, 'test prompt', [{ type: 'function', function: { name: 'noop', parameters: {} } }]);

    for await (const token of result.tokens) {
      tokens.push(token);
    }

    expect(tokens).toEqual(['hello', ' world']);
  });

  it('accumulates tool_calls from SSE delta chunks and returns them', async () => {
    mockSseResponse([
      // First chunk: tool call starts
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_xyz","type":"function","function":{"name":"get_weather","arguments":"{}"}}]}}]}\n\n`,
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ]);

    const result = await callLlmStreamWithTools(config, 'What is the weather?', [{ type: 'function', function: { name: 'get_weather', parameters: {} } }]);
    for await (const _ of result.tokens) { /* consume stream to populate toolCalls */ }

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].id).toBe('call_xyz');
    expect(result.toolCalls[0].function.name).toBe('get_weather');
  });

  it('handles multiple tool calls in a single response', async () => {
    mockSseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"tool_a","arguments":"{}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","type":"function","function":{"name":"tool_b","arguments":"{}"}}]}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ]);

    const result = await callLlmStreamWithTools(config, 'do multiple things', [
      { type: 'function', function: { name: 'tool_a', parameters: {} } },
      { type: 'function', function: { name: 'tool_b', parameters: {} } },
    ]);
    for await (const _ of result.tokens) { /* consume stream to populate toolCalls */ }

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].function.name).toBe('tool_a');
    expect(result.toolCalls[1].function.name).toBe('tool_b');
  });

  it('does NOT fire intake phase — caller handles intake for round tracking', async () => {
    // NOTE: callLlmStreamWithTools no longer fires 'intake' because the caller
    // (chat-manager._runAgentLoop) fires it before calling this function.
    // This prevents PhaseRegistry from incrementing round from 1→2 before the LLM starts.
    const phases: LlmPhase[] = [];

    mockSseResponse([
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ]);

    const options: LlmStreamOptions = {
      onPhaseChange: (phase) => phases.push(phase),
    };

    const result = await callLlmStreamWithTools(config, 'test', [{ type: 'function', function: { name: 'x', parameters: {} } }], options);
    for await (const _ of result.tokens) { /* consume */ }

    expect(phases).not.toContain('intake');
    expect(phases).toContain('done');
  });

  it('fires done phase on finish_reason stop', async () => {
    const phases: LlmPhase[] = [];

    mockSseResponse([
      'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ]);

    const options: LlmStreamOptions = {
      onPhaseChange: (phase) => phases.push(phase),
    };

    const result = await callLlmStreamWithTools(config, 'test', [{ type: 'function', function: { name: 'x', parameters: {} } }], options);
    for await (const _ of result.tokens) { /* consume */ }

    expect(phases).toContain('done');
  });

  it('phase sequence with tool calls: answering -> retrieving -> done (no intake — caller handles it)', async () => {
    // NOTE: callLlmStreamWithTools no longer fires 'intake'. The caller
    // (chat-manager._runAgentLoop) fires 'intake' before calling this function.
    const phases: LlmPhase[] = [];

    mockSseResponse([
      'data: {"choices":[{"delta":{"content":"checking"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{}"}}]}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ]);

    const options: LlmStreamOptions = {
      onPhaseChange: (phase) => phases.push(phase),
    };

    const result = await callLlmStreamWithTools(config, 'test', [{ type: 'function', function: { name: 'lookup', parameters: {} } }], options);
    for await (const _ of result.tokens) { /* consume */ }

    expect(phases).toEqual(['answering', 'retrieving', 'done']);
  });

  it('sends tools array in request body with stream:true', async () => {
    const capturedBodies: any[] = [];
    mockFetch.mockImplementation(async (url, init) => {
      capturedBodies.push(JSON.parse((init as any).body as string));
      const encoder = new TextEncoder();
      const readable = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"finish_reason":"stop"}]}\n\n'));
          controller.close();
        },
      });
      return { ok: true, body: readable } as any;
    });

    const tools = [{ type: 'function' as const, function: { name: 'get_weather', parameters: { type: 'object' } } }];
    await callLlmStreamWithTools(config, 'weather?', tools);

    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].tools).toEqual(tools);
    expect(capturedBodies[0].stream).toBe(true);
  });

  it('works without onPhaseChange callback (backward compat)', async () => {
    mockSseResponse([
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ]);

    const result = await callLlmStreamWithTools(config, 'test prompt', [{ type: 'function', function: { name: 'noop', parameters: {} } }]);

    const tokens: string[] = [];
    for await (const token of result.tokens) {
      tokens.push(token);
    }

    expect(tokens).toEqual(['hello']);
  });

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' } as any);

    await expect(
      callLlmStreamWithTools(config, 'prompt', [])
    ).rejects.toThrow('LLM stream tools HTTP 500 Internal Server Error');
  });

  it('supports abortSignal for cancellation', async () => {
    const controller = new AbortController();
    controller.abort();

    mockFetch.mockImplementation(() => {
      throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    });

    await expect(
      callLlmStreamWithTools(config, 'prompt', [], { abortSignal: controller.signal })
    ).rejects.toThrow(/abort/i);
  });

  // Issue #175: reasoning_content detection in callLlmStreamWithTools
  it('detects delta.reasoning_content and fires reasoning phase with token count', async () => {
    const phases: LlmPhase[] = [];
    const counts: number[] = [];

    mockSseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"more thought"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ]);

    const options: LlmStreamOptions = {
      onPhaseChange: (phase, tokenCount) => {
        phases.push(phase);
        counts.push(tokenCount);
      },
    };

    const result = await callLlmStreamWithTools(config, 'test prompt', [{ type: 'function', function: { name: 'noop', parameters: {} } }], options);
    for await (const _ of result.tokens) { /* consume */ }

    expect(phases).toContain('reasoning');
    // Two reasoning tokens fired
    const reasoningCalls = phases.filter((p, i) => p === 'reasoning' && counts[i] >= 1);
    expect(reasoningCalls.length).toBe(2);
    // Token counts should increment: 1, then 2
    expect(counts[phases.indexOf('reasoning')]).toBe(1);
  });

  it('reasoning phase fires before answering when reasoning_content precedes content', async () => {
    const phases: LlmPhase[] = [];

    mockSseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ]);

    const options: LlmStreamOptions = {
      onPhaseChange: (phase) => phases.push(phase),
    };

    const result = await callLlmStreamWithTools(config, 'test prompt', [{ type: 'function', function: { name: 'noop', parameters: {} } }], options);
    for await (const _ of result.tokens) { /* consume */ }

    // reasoning must appear before answering in the phase sequence
    const reasoningIdx = phases.indexOf('reasoning');
    const answeringIdx = phases.indexOf('answering');
    expect(reasoningIdx).toBeGreaterThanOrEqual(0);
    expect(answeringIdx).toBeGreaterThan(reasoningIdx);
  });

  it('does not yield reasoning_content tokens to the consumer', async () => {
    mockSseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"internal thought"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"visible answer"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ]);

    const tokens: string[] = [];
    const result = await callLlmStreamWithTools(config, 'test prompt', [{ type: 'function', function: { name: 'noop', parameters: {} } }]);
    for await (const token of result.tokens) {
      tokens.push(token);
    }

    // Only content tokens should be yielded, not reasoning_content
    expect(tokens).toEqual(['visible answer']);
    expect(tokens.join('')).not.toContain('internal thought');
  });
});
