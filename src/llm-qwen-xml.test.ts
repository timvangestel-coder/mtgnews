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

/**
 * Helper to build a valid SSE data line with proper JSON escaping.
 * Takes the raw content string and wraps it in a proper SSE JSON payload.
 */
function sseContent(content: string): string {
  const json = JSON.stringify({ choices: [{ delta: { content } }] });
  return `data: ${json}\n\n`;
}

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

describe('Qwen XML tool call parsing', () => {
  it('parses single Qwen XML tool call from content stream', async () => {
    // Simulate Qwen outputting the full tool_call XML in one content chunk.
    const xmlContent = '<tool_code>\n' +
      '<parameter_code>get_compact_text</parameter_code>\n' +
      '<parameter_code>{"video_id":"RPEzKMfsJvg"}</parameter_code>\n' +
      '</tool_code>';

    mockSseResponse([sseContent(xmlContent), 'data: {"choices":[{"finish_reason":"stop"}]}\n\n']);

    const result = await callLlmStreamWithTools(
      config,
      'Tell me about this video',
      [{ type: 'function', function: { name: 'get_compact_text', parameters: {} } }]
    );

    // Consume the token stream to trigger parsing
    const tokens: string[] = [];
    for await (const token of result.tokens) {
      tokens.push(token);
    }

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe('get_compact_text');
    const args = JSON.parse(result.toolCalls[0].function.arguments);
    expect(args.video_id).toBe('RPEzKMfsJvg');
  });

  it('parses Qwen XML tool call fragmented across multiple SSE chunks', async () => {
    // Simulate the XML being split across multiple content chunks — realistic SSE scenario
    mockSseResponse([
      sseContent('<tool_code>\n'),
      sseContent('<parameter_code>get_compact_text</parameter_code>\n'),
      sseContent('<parameter_code>{"video_id":"RPEzKMfsJvg"}</parameter_code>\n'),
      sseContent('</tool_code>'),
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ]);

    const result = await callLlmStreamWithTools(
      config,
      'Tell me about this video',
      [{ type: 'function', function: { name: 'get_compact_text', parameters: {} } }]
    );

    const tokens: string[] = [];
    for await (const token of result.tokens) {
      tokens.push(token);
    }

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe('get_compact_text');
  });

  it('does not produce tool calls when content has no Qwen XML', async () => {
    // Plain content — no XML markers at all
    mockSseResponse([
      sseContent('Hello'),
      sseContent(' world'),
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ]);

    const result = await callLlmStreamWithTools(
      config,
      'Say hello',
      [{ type: 'function', function: { name: 'noop', parameters: {} } }]
    );

    const tokens: string[] = [];
    for await (const token of result.tokens) {
      tokens.push(token);
    }

    expect(result.toolCalls).toHaveLength(0);
    expect(tokens).toEqual(['Hello', ' world']);
  });

  it('fires retrieving phase when Qwen XML tool call is detected', async () => {
    const phases: LlmPhase[] = [];

    const xmlContent = '<tool_code>\n' +
      '<parameter_code>lookup</parameter_code>\n' +
      '<parameter_code>{"x":1}</parameter_code>\n' +
      '</tool_code>';

    mockSseResponse([sseContent(xmlContent), 'data: {"choices":[{"finish_reason":"stop"}]}\n\n']);

    const options: LlmStreamOptions = {
      onPhaseChange: (phase) => phases.push(phase),
    };

    const result = await callLlmStreamWithTools(
      config,
      'test',
      [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
      options
    );

    for await (const _ of result.tokens) { /* consume */ }

    expect(phases).toContain('retrieving');
  });

  it('assigns a generated id to Qwen XML tool calls', async () => {
    const xmlContent = '<tool_code>\n' +
      '<parameter_code>fn</parameter_code>\n' +
      '<parameter_code>{"a":1}</parameter_code>\n' +
      '</tool_code>';

    mockSseResponse([sseContent(xmlContent), 'data: {"choices":[{"finish_reason":"stop"}]}\n\n']);

    const result = await callLlmStreamWithTools(
      config,
      'test',
      [{ type: 'function', function: { name: 'fn', parameters: {} } }]
    );

    for await (const _ of result.tokens) { /* consume */ }

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].id).toBeDefined();
    expect(typeof result.toolCalls[0].id).toBe('string');
    expect(result.toolCalls[0].id.length).toBeGreaterThan(0);
  });

  it('handles Qwen XML with heavily fragmented single characters', async () => {
    // Extreme fragmentation: each SSE chunk is a single character of the XML
    const xmlParts = [
      '<', 't', 'o', 'o', 'l', '_', 'c', 'o', 'd', 'e', '>', '\n',
      '<', 'p', 'a', 'r', 'a', 'm', 'e', 't', 'e', 'r', '_', 'c', 'o', 'd', 'e', '>',
      'g', 'e', 't', '_', 'c', 'o', 'm', 'p', 'a', 'c', 't', '_', 't', 'e', 'x', 't',
      '</', 'p', 'a', 'r', 'a', 'm', 'e', 't', 'e', 'r', '_', 'c', 'o', 'd', 'e', '>', '\n',
      '<', 'p', 'a', 'r', 'a', 'm', 'e', 't', 'e', 'r', '_', 'c', 'o', 'd', 'e', '>',
      '{', '"', 'v', 'i', 'd', 'e', 'o', '_', 'i', 'd', '"', ':', '"', 'A', 'B', 'C', '"', '}',
      '</', 'p', 'a', 'r', 'a', 'm', 'e', 't', 'e', 'r', '_', 'c', 'o', 'd', 'e', '>', '\n',
      '<', '/', 't', 'o', 'o', 'l', '_', 'c', 'o', 'd', 'e', '>',
    ];

    const chunks = xmlParts.map(ch => sseContent(ch));
    chunks.push('data: {"choices":[{"finish_reason":"stop"}]}\n\n');

    mockSseResponse(chunks);

    const result = await callLlmStreamWithTools(
      config,
      'test',
      [{ type: 'function', function: { name: 'get_compact_text', parameters: {} } }]
    );

    for await (const _ of result.tokens) { /* consume */ }

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe('get_compact_text');
  });
});