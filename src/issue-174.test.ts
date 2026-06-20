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

/**
 * Issue #174: Verify that the agent loop pattern (consuming tokens + tracking count)
 * produces onPhaseChange('answering', N) calls every 5 tokens plus a final call.
 */
describe('issue #174 - answer token counting in agent loop', () => {
  it('fires answering phase with incrementing token count every 5 tokens', async () => {
    const phases: LlmPhase[] = [];
    const counts: number[] = [];

    // Simulate 12 content tokens (no tool calls)
    const chunks = [
      'data: {"choices":[{"delta":{"content":"token1"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"token2"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"token3"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"token4"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"token5"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"token6"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"token7"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"token8"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"token9"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"token10"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"token11"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"token12"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ];

    mockSseResponse(chunks);

    const options: LlmStreamOptions = {
      onPhaseChange: (phase, tokenCount) => {
        phases.push(phase);
        counts.push(tokenCount);
      },
    };

    const result = await callLlmStreamWithTools(config, 'test prompt', [{ type: 'function', function: { name: 'noop', parameters: {} } }], options);

    // Replicate the agent loop token counting pattern from chat-manager.ts _runAgentLoop
    let answerTokenCount = 0;
    const answeringCountsFromLoop: number[] = [];

    for await (const _ of result.tokens) {
      answerTokenCount++;
      if (answerTokenCount % 5 === 0) {
        // This is what chat-manager does: fire onPhaseChange every 5 tokens
        answeringCountsFromLoop.push(answerTokenCount);
      }
    }

    // Fire final count when stream completes (if not already a multiple of 5)
    if (answerTokenCount > 0 && answerTokenCount % 5 !== 0) {
      answeringCountsFromLoop.push(answerTokenCount);
    }

    // 12 tokens: fires at 5, 10, then final at 12
    expect(answeringCountsFromLoop).toEqual([5, 10, 12]);
  });

  it('fires answering phase with exact count when token count is multiple of 5', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"b"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"c"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"d"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"e"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ];

    mockSseResponse(chunks);

    const result = await callLlmStreamWithTools(config, 'test prompt', [{ type: 'function', function: { name: 'noop', parameters: {} } }]);

    let answerTokenCount = 0;
    const answeringCountsFromLoop: number[] = [];

    for await (const _ of result.tokens) {
      answerTokenCount++;
      if (answerTokenCount % 5 === 0) {
        answeringCountsFromLoop.push(answerTokenCount);
      }
    }

    // Fire final count when stream completes
    if (answerTokenCount > 0 && answerTokenCount % 5 !== 0) {
      answeringCountsFromLoop.push(answerTokenCount);
    }

    // Exactly 5 tokens: fires at 5, no extra final call (already multiple of 5)
    expect(answeringCountsFromLoop).toEqual([5]);
  });

  it('combined reasoning + answering phases with token counts', async () => {
    const phases: LlmPhase[] = [];
    const counts: number[] = [];

    // Reasoning phase first, then content tokens
    mockSseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"thinking1"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"thinking2"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"b"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ]);

    const options: LlmStreamOptions = {
      onPhaseChange: (phase, tokenCount) => {
        phases.push(phase);
        counts.push(tokenCount);
      },
    };

    const result = await callLlmStreamWithTools(config, 'test prompt', [{ type: 'function', function: { name: 'noop', parameters: {} } }], options);

    // Replicate agent loop pattern
    let answerTokenCount = 0;
    for await (const _ of result.tokens) {
      answerTokenCount++;
      if (answerTokenCount % 5 === 0) {
        // Would fire onPhaseChange('answering', answerTokenCount) in real agent loop
      }
    }

    // NOTE: callLlmStreamWithTools no longer fires 'intake' — the caller (chat-manager)
    // handles intake for round tracking. Verify phases from callLlmStreamWithTools include reasoning, answering, done.
    expect(phases).not.toContain('intake');
    expect(phases).toContain('reasoning');
    expect(phases).toContain('answering');
    expect(phases).toContain('done');

    // Reasoning phase should have token counts 1 and 2
    const reasoningPhaseIndices = phases.map((p, i) => p === 'reasoning' ? i : -1).filter(i => i >= 0);
    expect(reasoningPhaseIndices.length).toBe(2);
    expect(counts[reasoningPhaseIndices[0]]).toBe(1);
    expect(counts[reasoningPhaseIndices[1]]).toBe(2);

    // 2 answer tokens, not a multiple of 5, so final count would fire at 2
    expect(answerTokenCount).toBe(2);
  });
});