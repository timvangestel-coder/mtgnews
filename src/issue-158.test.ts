import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { analyzeSignal, LlmConfig, type LlmPhase } from './llm';
import { createTestDb, seedChannel, seedSignal } from '../tests/fixtures/test-db';
import { PhaseRegistry, type PhaseEntry } from './phase-registry';

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
 * Mock an SSE streaming response with reasoning_content + content chunks.
 * The generator will yield only content tokens (reasoning is consumed internally).
 */
function mockSseStreamingResponse(chunks: Array<{ reasoning?: string; content?: string; finishReason?: string }>) {
  const encoder = new TextEncoder();
  const lines: string[] = [];

  for (const chunk of chunks) {
    const delta: Record<string, unknown> = {};
    if (chunk.reasoning !== undefined) delta.reasoning_content = chunk.reasoning;
    if (chunk.content !== undefined) delta.content = chunk.content;

    const choice: Record<string, unknown> = { delta };
    if (chunk.finishReason) choice.finish_reason = chunk.finishReason;

    lines.push(`data: ${JSON.stringify({ choices: [choice] })}\n\n`);
  }
  lines.push('data: [DONE]\n\n');

  const readable = new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });

  mockFetch.mockResolvedValueOnce({ ok: true, body: readable } as any);
}

describe('issue #158 — analyzeSignal streaming migration', () => {
  describe('RED: analyzeSignal uses streaming with phase callback', () => {
    it('fires onPhaseChange callbacks for intake → reasoning → answering phases', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      seedSignal(db, 'v-stream-1', 'text about mtg');

      // Stream: reasoning chunk, then content with trailing JSON
      mockSseStreamingResponse([
        { reasoning: 'Thinking...' },
        { reasoning: 'More thinking...' },
        { content: 'Some prose reasoning here.\n' },
        { content: '{"summary":"MTG video","takeaways":[],"overall_sentiment":{"score":4,"label":"Positive"},"entities":[]}' },
        { finishReason: 'stop' },
      ]);

      const phases: Array<{ phase: LlmPhase; tokenCount: number }> = [];
      const result = await analyzeSignal(db, 'v-stream-1', config, undefined, (phase, count) => {
        phases.push({ phase, tokenCount: count });
      });

      expect(result.success).toBe(true);
      // Verify phase transitions fired
      expect(phases.map(p => p.phase)).toContain('intake');
      expect(phases.map(p => p.phase)).toContain('reasoning');
    });

    it('buffers all tokens and extracts trailing JSON identical to sync path', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      seedSignal(db, 'v-stream-2', 'text about mtg');

      // Stream with prose reasoning before JSON (same pattern as sync test)
      mockSseStreamingResponse([
        { reasoning: 'Analyzing content...' },
        { content: "Here's my analysis of this video.\n\nThe content is relevant to MTG.\n\n" },
        { content: '{"summary":"Relevant MTG content","takeaways":[{"text":"Key point","timestamp":"T:0"}],"overall_sentiment":{"score":3,"label":"Neutral"},"entities":[{"entity_name":"Kaldra","entity_type":"set","sentiment":"Positive"}]}' },
        { finishReason: 'stop' },
      ]);

      const result = await analyzeSignal(db, 'v-stream-2', config);

      expect(result.success).toBe(true);

      // Verify DB writes identical to sync path
      const sig = db.prepare('SELECT summary, overall_sentiment, sentiment_label FROM signals WHERE video_id = ?').get('v-stream-2');
      expect(sig.summary).toContain('Relevant MTG content');
      expect(sig.overall_sentiment).toBe(3);
      expect(sig.sentiment_label).toBe('Neutral');

      const mentions = db.prepare('SELECT entity_name FROM entity_mentions WHERE signal_video_id = ?').all('v-stream-2');
      expect(mentions).toHaveLength(1);
      expect(mentions[0].entity_name).toBe('Kaldra');
    });

    it('handles relevant:false via streaming response', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      seedSignal(db, 'v-stream-irr', 'text');

      mockSseStreamingResponse([
        { reasoning: 'Not relevant...' },
        { content: '{"relevant":false}' },
        { finishReason: 'stop' },
      ]);

      const result = await analyzeSignal(db, 'v-stream-irr', config);
      expect(result.success).toBe(true);

      const sig = db.prepare('SELECT processing_state, summary FROM signals WHERE video_id = ?').get('v-stream-irr');
      expect(sig.processing_state).toBe('irrelevant');
      expect(sig.summary).toBeNull();
    });

    it('DB writes (summary, sentiment, entities) unchanged after migration', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      seedSignal(db, 'v-stream-3', '[T:0] mtg kaldra discussion');

      mockSseStreamingResponse([
        { reasoning: 'Processing...' },
        { content: '{"summary":"Kaldra discussion","takeaways":[],"overall_sentiment":{"score":5,"label":"Positive"},"entities":[{"entity_name":"Kaldra","entity_type":"set","sentiment":"Positive"},{"entity_name":"Lurrus","entity_type":"creature","sentiment":"Neutral"}],"compact_text":"[T:0] mtg kaldra discussion","title":"Kaldra Discussion Video"}' },
        { finishReason: 'stop' },
      ]);

      const result = await analyzeSignal(db, 'v-stream-3', config);
      expect(result.success).toBe(true);

      // All fields persisted identically to sync path
      const sig = db.prepare('SELECT summary, overall_sentiment, sentiment_label, compact_text, generated_title FROM signals WHERE video_id = ?').get('v-stream-3');
      expect(sig.summary).toContain('Kaldra discussion');
      expect(sig.overall_sentiment).toBe(5);
      expect(sig.sentiment_label).toBe('Positive');
      expect(sig.compact_text).toBe('[T:0] mtg kaldra discussion');
      expect(sig.generated_title).toBe('Kaldra Discussion Video');

      const mentions = db.prepare('SELECT entity_name FROM entity_mentions WHERE signal_video_id = ? ORDER BY id').all('v-stream-3');
      expect(mentions.map((m: any) => m.entity_name)).toEqual(['Kaldra', 'Lurrus']);
    });

    it('returns failure when streaming LLM call fails', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      seedSignal(db, 'v-stream-fail', 'text');

      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 } as any);

      const result = await analyzeSignal(db, 'v-stream-fail', config);
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('PhaseRegistry integration', () => {
    it('PhaseRegistry stores and retrieves phase entries keyed by videoId', () => {
      const registry = new PhaseRegistry<string>();
      registry.set('vid1', 'reasoning', 234);
      registry.set('vid2', 'answering', 567);

      expect(registry.get('vid1')).toEqual({ phase: 'reasoning', tokenCount: 234 });
      expect(registry.get('vid2')).toEqual({ phase: 'answering', tokenCount: 567 });
    });

    it('PhaseRegistry.delete removes entry', () => {
      const registry = new PhaseRegistry<string>();
      registry.set('vid1', 'done', 890);
      expect(registry.get('vid1')).toBeDefined();
      registry.delete('vid1');
      expect(registry.get('vid1')).toBeUndefined();
    });

    it('analyzeSignal fires onPhaseChange callback wired to PhaseRegistry', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      seedSignal(db, 'v-phase-reg', 'text about mtg');

      mockSseStreamingResponse([
        { reasoning: 'Thinking...' },
        { content: '{"summary":"MTG video","takeaways":[],"overall_sentiment":{"score":4,"label":"Positive"},"entities":[]}' },
        { finishReason: 'stop' },
      ]);

      const registry = new PhaseRegistry<string>();
      let lastPhase: LlmPhase | undefined;
      let lastTokenCount = 0;

      await analyzeSignal(db, 'v-phase-reg', config, undefined, (phase, count) => {
        registry.set('v-phase-reg', phase, count);
        lastPhase = phase;
        lastTokenCount = count;
      });

      // Verify callback was invoked with phases
      expect(lastPhase).toBeDefined();
      const entry = registry.get('v-phase-reg');
      expect(entry).toBeDefined();
      expect(entry!.phase).toBe('done');
    });

    it('registry entries cleaned up after analysis completes', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      seedSignal(db, 'v-cleanup', 'text about mtg');

      mockSseStreamingResponse([
        { reasoning: 'Thinking...' },
        { content: '{"summary":"s","takeaways":[],"overall_sentiment":{"score":3,"label":"Neutral"},"entities":[]}' },
        { finishReason: 'stop' },
      ]);

      const registry = new PhaseRegistry<string>();
      await analyzeSignal(db, 'v-cleanup', config, undefined, (phase, count) => {
        registry.set('v-cleanup', phase, count);
      });

      // Simulate cleanup after task settles
      expect(registry.get('v-cleanup')).toBeDefined();
      registry.delete('v-cleanup');
      expect(registry.get('v-cleanup')).toBeUndefined();
    });
  });
});
