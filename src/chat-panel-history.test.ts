import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

function readChatPanelSource() {
  const srcPath = path.resolve(__dirname, '../views/scripts/chat-panel.js');
  return fs.readFileSync(srcPath, 'utf-8');
}

/**
 * Regression tests for chat-panel.js scope handling.
 * These source-level probes verify the ScopeSource architecture is in place:
 * - Scope reads happen via ScopeSource.fromCurrentURL() (no stale Alpine state)
 * - URL building uses ScopeSource.buildHistoryURL() (params always appended)
 * - Ask body uses ScopeSource.buildAskBody() (correct scope sent to backend)
 */
describe('chat-panel.js — uses ScopeSource for scope reads', () => {
  it('reads scope via ScopeSource.fromCurrentURL in loadHistory', () => {
    const source = readChatPanelSource();
    // loadHistory must use ScopeSource, not manual params arrays
    expect(source).toMatch(/ScopeSource\.fromCurrentURL/);
    expect(source).toMatch(/ScopeSource\.buildHistoryURL/);
  });

  it('reads scope via ScopeSource.fromCurrentURL in sendQuestion', () => {
    const source = readChatPanelSource();
    // sendQuestion must use ScopeSource.buildAskBody, not manual body construction
    expect(source).toMatch(/ScopeSource\.buildAskBody/);
  });

  it('does NOT maintain stale topicKey/channelId Alpine state', () => {
    const source = readChatPanelSource();
    // After ScopeSource refactor: no this.topicKey or this.channelId reactive props
    // Scope is read from URL at point-of-use instead
    expect(source).not.toMatch(/this\.topicKey\s*[=]/);
    expect(source).not.toMatch(/this\.channelId\s*[=]/);
  });

  it('does NOT use _syncScopeFromUrl (replaced by ScopeSource)', () => {
    const source = readChatPanelSource();
    // _syncScopeFromUrl was deleted — ScopeSource.fromCurrentURL replaces it
    expect(source).not.toMatch(/_syncScopeFromUrl/);
  });

  it('does NOT use savedTopicKey/savedChannelId drift-prone state', () => {
    const source = readChatPanelSource();
    // These props were the root cause of scope drift — deleted in refactor
    expect(source).not.toMatch(/savedTopicKey/);
    expect(source).not.toMatch(/savedChannelId/);
  });
});

/**
 * Test: pagination preserves topicKey in _signalsTable.ejs
 */
describe('_signalsTable.ejs — pagination preserves topicKey', () => {
  it('Previous/Next buttons include topicKey in query params', () => {
    const srcPath = path.resolve(__dirname, '../views/_signalsTable.ejs');
    const source = fs.readFileSync(srcPath, 'utf-8');

    // Both prevParams and nextParams must set topicKey
    expect(source).toMatch(/prevParams\.set\(['"]topicKey/);
    expect(source).toMatch(/nextParams\.set\(['"]topicKey/);
  });
});

/**
 * Test: scope-source.js exists as the deep module
 */
describe('scope-source.js — ScopeSource module exists', () => {
  it('scope-source.js is present in views/scripts/', () => {
    const srcPath = path.resolve(__dirname, '../views/scripts/scope-source.js');
    expect(fs.existsSync(srcPath)).toBe(true);
  });

  it('exports fromCurrentURL, buildHistoryURL, and buildAskBody', () => {
    const srcPath = path.resolve(__dirname, '../views/scripts/scope-source.js');
    const source = fs.readFileSync(srcPath, 'utf-8');
    expect(source).toMatch(/fromCurrentURL/);
    expect(source).toMatch(/buildHistoryURL/);
    expect(source).toMatch(/buildAskBody/);
  });
});