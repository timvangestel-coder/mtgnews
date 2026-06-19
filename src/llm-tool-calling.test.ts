import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { callLlmWithTools, ToolCallResult, callLlmStreamWithTools } from './llm';

const mockFetch = vi.fn();
const originalFetch = global.fetch;

describe('callLlmWithTools', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.stubGlobal('fetch', originalFetch);
  });

  it('sends tools array in request body', async () => {
    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'get_weather',
          description: 'Get the current weather in a location',
          parameters: {
            type: 'object',
            properties: {
              city: { type: 'string', description: 'The city name' },
            },
            required: ['city'],
          },
        },
      },
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_abc123',
                  type: 'function',
                  function: JSON.stringify({
                    name: 'get_weather',
                    arguments: '{"city":"London"}',
                  }),
                },
              ],
            },
          },
        ],
      }),
    } as any);

    const result = await callLlmWithTools(
      { endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'qwen/qwen3.6-27b' },
      'What is the weather in London?',
      tools
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.tools).toEqual(tools);
    expect(body.messages).toEqual([{ role: 'user', content: 'What is the weather in London?' }]);
  });

  it('returns tool_calls with function name and arguments', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_xyz789',
                  type: 'function',
                  function: JSON.stringify({
                    name: 'get_weather',
                    arguments: '{"city":"London"}',
                  }),
                },
              ],
            },
          },
        ],
      }),
    } as any);

    const result = await callLlmWithTools(
      { endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'qwen/qwen3.6-27b' },
      'What is the weather?',
      [{ type: 'function', function: { name: 'get_weather', parameters: {} } }]
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].id).toBe('call_xyz789');
    expect(result.toolCalls[0].function.name).toBe('get_weather');
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({ city: 'London' });
  });

  it('throws when response has no tool_calls', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: 'I cannot answer that.', role: 'assistant' } }],
      }),
    } as any);

    await expect(
      callLlmWithTools(
        { endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'qwen/qwen3.6-27b' },
        'What is the weather?',
        [{ type: 'function', function: { name: 'get_weather', parameters: {} } }]
      )
    ).rejects.toThrow('LLM tool calling returned unexpected response');
  });

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' } as any);

    await expect(
      callLlmWithTools(
        { endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'qwen/qwen3.6-27b' },
        'prompt',
        []
      )
    ).rejects.toThrow('LLM tool calling HTTP 500 Internal Server Error');
  });
});

/**
 * Integration smoke test — runs against the real LM Studio endpoint.
 * Skipped by default. Enable with: npx vitest run --testNamePattern "smoke"
 *
 * Verifies Qwen XML tool calling works end-to-end via callLlmStreamWithTools.
 * The model returns <tool_code> XML in content, which the parser converts to ToolCall objects.
 */
describe('callLlmStreamWithTools smoke test', () => {
  it.skip(
    'Qwen XML tool calling works on local LM Studio with qwen/qwen3.6-27b',
    async () => {
      const tools = [
        {
          type: 'function' as const,
          function: {
            name: 'add_numbers',
            description: 'Add two numbers together',
            parameters: {
              type: 'object',
              properties: {
                a: { type: 'number', description: 'First number' },
                b: { type: 'number', description: 'Second number' },
              },
              required: ['a', 'b'],
            },
          },
        },
      ];

      const result = await callLlmStreamWithTools(
        { endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'qwen/qwen3.6-27b' },
        'Add 3 and 5',
        tools
      );

      // Consume the token stream to trigger parsing
      for await (const _ of result.tokens) { /* consume */ }

      expect(result.toolCalls.length).toBeGreaterThan(0);
      expect(result.toolCalls[0].function.name).toBe('add_numbers');

      const args = JSON.parse(result.toolCalls[0].function.arguments);
      expect(args.a).toBeDefined();
      expect(args.b).toBeDefined();
    },
    120_000
  );
});