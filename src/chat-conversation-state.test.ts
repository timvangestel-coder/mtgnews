import { describe, it, expect } from 'vitest';
import { createConversationState, createAgentConversation, type ConversationTurn, type SignalIndexEntry } from './chat-conversation-state';

describe('ConversationState', () => {
  it('buildPrompt returns base prompt when no turns added', () => {
    const state = createConversationState();
    expect(state.buildPrompt('Tell me about X')).toBe('Tell me about X');
  });

  it('appends assistant tool call turn', () => {
    const state = createConversationState();
    state.addTurn({
      role: 'assistant',
      toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'get_compact_text', arguments: '{"videoIds":["abc"]}' } }],
    });

    const prompt = state.buildPrompt('Base prompt');
    expect(prompt).toContain('Assistant called get_compact_text({"videoIds":["abc"]})');
  });

  it('appends tool result turn', () => {
    const state = createConversationState();
    state.addTurn({ role: 'tool', content: '{"data":"result"}', toolCallId: 'tc1' });

    const prompt = state.buildPrompt('Base prompt');
    expect(prompt).toContain('Tool Result (tc1): {"data":"result"}');
  });

  it('does NOT create recursive nesting across rounds', () => {
    const state = createConversationState();
    const basePrompt = 'Answer this question about videos';

    // Simulate Round 1: add assistant call + tool result
    state.addTurn({
      role: 'assistant',
      toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'get_compact_text', arguments: '{"videoIds":["v1"]}' } }],
    });
    state.addTurn({ role: 'tool', content: '[{"videoId":"v1","content":"compact text here"}]', toolCallId: 'tc1' });

    const round1Prompt = state.buildPrompt(basePrompt);
    const round1Length = round1Prompt.length;

    // Simulate Round 2: add another assistant call + tool result
    state.addTurn({
      role: 'assistant',
      toolCalls: [{ id: 'tc2', type: 'function', function: { name: 'get_compact_text', arguments: '{"videoIds":["v2"]}' } }],
    });
    state.addTurn({ role: 'tool', content: '[{"videoId":"v2","content":"more compact text"}]', toolCallId: 'tc2' });

    const round2Prompt = state.buildPrompt(basePrompt);
    const round2Length = round2Prompt.length;

    // Round 2 should be larger than Round 1 (new turns added)
    expect(round2Length).toBeGreaterThan(round1Length);

    // CRITICAL: Round 2 must NOT contain the round 1 prompt embedded inside it.
    // The base prompt appears exactly once. No recursive nesting.
    const basePromptOccurrences = (round2Prompt.match(new RegExp(escapeRegex(basePrompt), 'g')) || []).length;
    expect(basePromptOccurrences).toBe(1);

    // Round 1's serialized history should NOT be re-embedded as "User: {round1}" in round 2
    // This is the exact bug we're preventing
    expect(round2Prompt).not.toContain('User: ' + basePrompt);
  });

  it('handles multiple tool calls in one round', () => {
    const state = createConversationState();

    state.addTurn({
      role: 'assistant',
      toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'get_compact_text', arguments: '{"videoIds":["a"]}' } }],
    });
    state.addTurn({ role: 'tool', content: 'result A', toolCallId: 'tc1' });
    state.addTurn({
      role: 'assistant',
      toolCalls: [{ id: 'tc2', type: 'function', function: { name: 'get_compact_text', arguments: '{"videoIds":["b"]}' } }],
    });
    state.addTurn({ role: 'tool', content: 'result B', toolCallId: 'tc2' });

    const prompt = state.buildPrompt('Base');
    expect(prompt).toContain('Assistant called get_compact_text({"videoIds":["a"]})');
    expect(prompt).toContain('Tool Result (tc1): result A');
    expect(prompt).toContain('Assistant called get_compact_text({"videoIds":["b"]})');
    expect(prompt).toContain('Tool Result (tc2): result B');
  });

  it('ignores turns with no recognizable content', () => {
    const state = createConversationState();
    // A user turn has no special formatting in this module — just ignored
    state.addTurn({ role: 'user', content: 'ignored' });
    state.addTurn({ role: 'tool', content: 'visible', toolCallId: 't1' });

    const prompt = state.buildPrompt('Base');
    expect(prompt).toContain('Tool Result (t1): visible');
  });
});

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('AgentConversation (round-aware prompt)', () => {
  const signalIndex: SignalIndexEntry[] = [
    { videoId: 'v1', title: 'Video One', summary: 'Summary of video one' },
    { videoId: 'v2', title: 'Video Two', summary: 'Summary of video two' },
  ];

  it('Round 1 includes the signal index', () => {
    const conv = createAgentConversation(signalIndex, 'What about X?', []);
    const prompt = conv.buildNextPrompt();

    // Must contain signal data
    expect(prompt).toContain('v1');
    expect(prompt).toContain('Video One');
    expect(prompt).toContain('Summary of video one');
    expect(prompt).toContain('What about X?');
  });

  it('Round 2 drops the signal index but keeps question + tool results', () => {
    const conv = createAgentConversation(signalIndex, 'What about X?', []);

    // Round 1: build prompt (should have signal index)
    const round1Prompt = conv.buildNextPrompt();
    expect(round1Prompt).toContain('Video One');

    // Simulate tool call + result
    conv.addToolCall(
      { id: 'tc1', type: 'function', function: { name: 'get_compact_text', arguments: '{"videoIds":["v1"]}' } },
      '[{"videoId":"v1","title":"Video One","content":"compact text v1"}]'
    );

    // Round 2: build prompt (should NOT have signal index)
    const round2Prompt = conv.buildNextPrompt();
    expect(round2Prompt).not.toContain('Summary of video one');
    expect(round2Prompt).not.toContain('Video Two');
    // But must keep the question and tool results
    expect(round2Prompt).toContain('What about X?');
    expect(round2Prompt).toContain('compact text v1');
  });

  it('Round 3 also drops the signal index', () => {
    const conv = createAgentConversation(signalIndex, 'What about X?', []);

    // Round 1
    conv.buildNextPrompt();
    conv.addToolCall(
      { id: 'tc1', type: 'function', function: { name: 'get_compact_text', arguments: '{"videoIds":["v1"]}' } },
      'result1'
    );

    // Round 2
    const round2Prompt = conv.buildNextPrompt();
    expect(round2Prompt).not.toContain('Summary of video one');

    conv.addToolCall(
      { id: 'tc2', type: 'function', function: { name: 'get_compact_text', arguments: '{"videoIds":["v2"]}' } },
      'result2'
    );

    // Round 3
    const round3Prompt = conv.buildNextPrompt();
    expect(round3Prompt).not.toContain('Summary of video one');
    expect(round3Prompt).toContain('What about X?');
    expect(round3Prompt).toContain('result1');
    expect(round3Prompt).toContain('result2');
  });

  it('preserves chat history from previous exchanges', () => {
    const history = [{ question: 'Prev Q', answer: 'Prev A' }];
    const conv = createAgentConversation(signalIndex, 'What about X?', history);
    const prompt = conv.buildNextPrompt();

    expect(prompt).toContain('Prev Q');
    expect(prompt).toContain('Prev A');
  });

  it('Round 2 is significantly smaller than Round 1', () => {
    // Build a large signal index to make the difference obvious
    const bigIndex: SignalIndexEntry[] = [];
    for (let i = 0; i < 20; i++) {
      bigIndex.push({ videoId: `v${i}`, title: `Video ${i}`, summary: `This is a long summary for video number ${i} that takes up quite a bit of space in the prompt.` });
    }

    const conv = createAgentConversation(bigIndex, 'What about X?', []);
    const round1Prompt = conv.buildNextPrompt();

    // Simulate tool call + result
    conv.addToolCall(
      { id: 'tc1', type: 'function', function: { name: 'get_compact_text', arguments: '{"videoIds":["v0"]}' } },
      '[{"videoId":"v0","title":"Video 0","content":"compact text"}]'
    );

    const round2Prompt = conv.buildNextPrompt();

    // Round 2 must be smaller — the big signal index was dropped
    expect(round2Prompt.length).toBeLessThan(round1Prompt.length * 0.6);
  });
});
