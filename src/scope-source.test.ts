/**
 * ScopeSource tests — architecture improvement (Candidate 1).
 *
 * ScopeSource is a pure function that reads chat scope from the browser URL.
 * It eliminates Alpine state drift by providing a single source of truth:
 * all callers read scope at point-of-use via ScopeSource.fromURL().
 *
 * Tests are unit tests against the pure function logic. The function itself
 * is framework-agnostic (no Alpine, no HTMX) — it only reads URL params.
 */
import { describe, it, expect } from 'vitest';

// Import the module — it exports a pure function taking a URL string
import { ScopeSource, ChatScopeData } from './scope-source';

describe('ScopeSource.fromURL() — single truth for chat scope', () => {
  it('returns empty scope when URL has no query params', () => {
    const scope = ScopeSource.fromURL('http://localhost/signals');
    expect(scope.topicKey).toBeUndefined();
    expect(scope.channelId).toBeUndefined();
    expect(scope.includeIrrelevant).toBe(false);
  });

  it('returns topicKey when URL has ?topicKey=mtg', () => {
    const scope = ScopeSource.fromURL('http://localhost/signals?topicKey=mtg');
    expect(scope.topicKey).toBe('mtg');
    expect(scope.channelId).toBeUndefined();
  });

  it('returns channelId when URL has ?channelId=UC_test', () => {
    const scope = ScopeSource.fromURL('http://localhost/signals?channelId=UC_test');
    expect(scope.topicKey).toBeUndefined();
    expect(scope.channelId).toBe('UC_test');
  });

  it('returns both topicKey and channelId when both present', () => {
    const scope = ScopeSource.fromURL('http://localhost/signals?topicKey=mtg&channelId=UC_mtg_a');
    expect(scope.topicKey).toBe('mtg');
    expect(scope.channelId).toBe('UC_mtg_a');
  });

  it('ignores htmx=true param (HTMX artifact, not scope data)', () => {
    const scope = ScopeSource.fromURL('http://localhost/signals?topicKey=mtg&htmx=true');
    expect(scope.topicKey).toBe('mtg');
    // htmx param must not leak into scope
    expect(Object.keys(scope)).not.toContain('htmx');
  });

  it('preserves empty string topicKey as list-scope indicator (all signals)', () => {
    const scope = ScopeSource.fromURL('http://localhost/signals?topicKey=');
    // Empty string topicKey is a valid list-scope indicator meaning "all signals"
    expect(scope.topicKey).toBe('');
  });

  it('returns undefined when topicKey param is absent', () => {
    const scope = ScopeSource.fromURL('http://localhost/signals');
    // No topicKey param at all → undefined (not a list-scope filter)
    expect(scope.topicKey).toBeUndefined();
  });

  it('handles empty string channelId as undefined', () => {
    const scope = ScopeSource.fromURL('http://localhost/signals?channelId=');
    expect(scope.channelId).toBeUndefined();
  });

  it('decodes percent-encoded values', () => {
    const scope = ScopeSource.fromURL('http://localhost/signals?topicKey=my%20topic');
    expect(scope.topicKey).toBe('my topic');
  });

  it('returns includeIrrelevant when URL has ?includeIrrelevant=true', () => {
    const scope = ScopeSource.fromURL('http://localhost/signals?includeIrrelevant=true');
    expect(scope.includeIrrelevant).toBe(true);
  });

  it('treats includeIrrelevant as false when param is absent', () => {
    const scope = ScopeSource.fromURL('http://localhost/signals?topicKey=mtg');
    expect(scope.includeIrrelevant).toBe(false);
  });

  describe('buildHistoryURL() — constructs /chat/history URL with scope params', () => {
    it('returns bare /chat/history when scope is empty', () => {
      const url = ScopeSource.buildHistoryURL({});
      expect(url).toBe('/chat/history');
    });

    it('appends topicKey when present', () => {
      const url = ScopeSource.buildHistoryURL({ topicKey: 'mtg' });
      expect(url).toBe('/chat/history?topicKey=mtg');
    });

    it('appends channelId when present', () => {
      const url = ScopeSource.buildHistoryURL({ topicKey: 'mtg', channelId: 'UC_a' });
      expect(url).toContain('topicKey=mtg');
      expect(url).toContain('channelId=UC_a');
    });

    it('appends signalVideoId for per-signal chat', () => {
      const url = ScopeSource.buildHistoryURL({ signalVideoId: 'v1' });
      expect(url).toBe('/chat/history?signalVideoId=v1');
    });
  });

  describe('buildAskBody() — constructs POST body for /chat/ask', () => {
    it('includes topicKey from scope for list-scoped chat', () => {
      const body = ScopeSource.buildAskBody({ question: 'hello', topicKey: 'mtg' });
      expect(body.question).toBe('hello');
      expect(body.topicKey).toBe('mtg');
    });

    it('includes signalVideoId for per-signal chat', () => {
      const body = ScopeSource.buildAskBody({ question: 'hello', signalVideoId: 'v1' });
      expect(body.question).toBe('hello');
      expect(body.signalVideoId).toBe('v1');
      expect(body.topicKey).toBeUndefined();
    });

    it('omits empty channelId from body', () => {
      const body = ScopeSource.buildAskBody({ question: 'hello', topicKey: 'mtg', channelId: '' });
      expect(body.channelId).toBeUndefined();
    });
  });
});