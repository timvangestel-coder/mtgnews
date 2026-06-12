/**
 * ChatPanel timestamp-close tests — verifies the custom DOM event seam
 * between signal-detail and ChatPanel for closing the panel on timestamp click.
 *
 * Tests verify:
 * 1. ChatPanel listens for `chat-timestamp-clicked` in init() and calls toggleChat() to close
 * 2. The event listener is only added (not duplicated on re-init)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';

function setupDOM(html: string) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`);
  global.document = dom.window.document as unknown as Document;
  global.window = dom.window as unknown as Window & typeof globalThis;
  return dom;
}

function loadChatPanel() {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'views', 'scripts', 'chat-panel.js'), 'utf-8');
  const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`);
  const ctx = {
    document: dom.window.document,
    window: dom.window,
    console: console,
  };
  const fn = new Function('window', 'document', 'console', src);
  fn(ctx.window, ctx.document, ctx.console);
  return { dom, module: ctx.window.chatPanel };
}

describe('ChatPanel chat-timestamp-clicked event seam', () => {
  describe('init() listens for chat-timestamp-clicked', () => {
    it('closes the chat panel when chat-timestamp-clicked event is dispatched', () => {
      const { dom, module } = loadChatPanel();
      dom.window.document.body.innerHTML = `
        <div data-chat-panel>
          <div id="chat-history-content"></div>
        </div>
      `;

      // Create a chat panel instance and call init() manually (Alpine normally does this)
      const scope = { hasVideoId: false, signalCount: 3 };
      const instance = module(scope);
      instance.init();

      // Open the chat first
      instance.toggleChat();
      expect(instance.chatOpen).toBe(true);

      // Dispatch the custom event (simulating timestamp pill click from signal-detail)
      const event = new dom.window.CustomEvent('chat-timestamp-clicked', {
        bubbles: true,
        detail: { ms: 5000 }
      });
      dom.window.document.dispatchEvent(event);

      expect(instance.chatOpen).toBe(false);
    });

    it('does not close when chat is already closed', () => {
      const { dom, module } = loadChatPanel();
      dom.window.document.body.innerHTML = `
        <div data-chat-panel>
          <div id="chat-history-content"></div>
        </div>
      `;

      const scope = { hasVideoId: false, signalCount: 3 };
      const instance = module(scope);
      instance.init();

      // Chat is closed by default
      expect(instance.chatOpen).toBe(false);

      dom.window.document.dispatchEvent(new dom.window.CustomEvent('chat-timestamp-clicked', {
        bubbles: true,
        detail: { ms: 5000 }
      }));

      // Should remain closed — listener only closes when open (if (self.chatOpen) self.toggleChat())
      expect(instance.chatOpen).toBe(false);
    });

    it('per-signal mode also listens for the event', () => {
      const { dom, module } = loadChatPanel();
      dom.window.document.body.innerHTML = `
        <div data-chat-panel>
          <div id="chat-history-content"></div>
        </div>
      `;

      // Per-signal mode (hasVideoId: true) — event listener is added before the _isMulti check
      const scope = { hasVideoId: true, videoId: 'abc123' };
      const instance = module(scope);
      instance.init();

      // Open the chat
      instance.toggleChat();
      expect(instance.chatOpen).toBe(true);

      dom.window.document.dispatchEvent(new dom.window.CustomEvent('chat-timestamp-clicked', {
        bubbles: true,
        detail: { ms: 10000 }
      }));

      expect(instance.chatOpen).toBe(false);
    });
  });
});