/**
 * TimestampNav tests — framework-agnostic timestamp click interception module.
 *
 * TimestampNav provides document-level click delegation for timestamp pill links
 * across all pages. It replaces inline click handlers hardcoded in signal-detail.ejs.
 *
 * Tests verify the pure JS logic: init options, selector routing, and intercept mode.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Simulate browser DOM for testing
// @ts-ignore
import { JSDOM } from 'jsdom';

function setupDOM(html: string) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`);
  global.document = dom.window.document as unknown as Document;
  global.window = dom.window as unknown as Window & typeof globalThis;
  return dom;
}

function loadTimestampNav() {
  // Read and execute the browser module source
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'views', 'scripts', 'timestamp-nav.js'), 'utf-8');
  const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`);
  const ctx = {
    document: dom.window.document,
    window: dom.window,
    console: console,
  };
  // Evaluate in context with window global
  const fn = new Function('window', 'document', 'console', src);
  fn(ctx.window, ctx.document, ctx.console);
  return { dom, module: ctx.window.TimestampNav };
}

describe('TimestampNav.init() — document-level click delegation', () => {
  describe('samePage=true intercept mode', () => {
    it('calls onSummaryClick when clicking a summary pane timestamp link', async () => {
      const { dom, module } = loadTimestampNav();
      dom.window.document.body.innerHTML = `
        <div id="summary-pane">
          <a href="#t-5000" data-timestamp="5000">[00:05]</a>
        </div>
      `;

      const onSummaryClick = vi.fn();
      module.init({ samePage: true, onSummaryClick });

      const link = dom.window.document.querySelector('a[data-timestamp]');
      link?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

      expect(onSummaryClick).toHaveBeenCalledWith(5000);
    });

    it('calls onTranscriptClick when clicking a transcript pane timestamp link', async () => {
      const { dom, module } = loadTimestampNav();
      dom.window.document.body.innerHTML = `
        <div id="transcript-pane">
          <a href="#t-10000" data-timestamp="10000">[00:10]</a>
        </div>
      `;

      const onTranscriptClick = vi.fn();
      module.init({ samePage: true, onTranscriptClick });

      const link = dom.window.document.querySelector('a[data-timestamp]');
      link?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

      expect(onTranscriptClick).toHaveBeenCalledWith(10000);
    });

    it('calls onChatClick when clicking a chat panel timestamp link', async () => {
      const { dom, module } = loadTimestampNav();
      dom.window.document.body.innerHTML = `
        <div data-chat-panel>
          <div class="chat-history">
            <a href="#t-15000" data-timestamp="15000">[00:15]</a>
          </div>
        </div>
      `;

      const onChatClick = vi.fn();
      module.init({ samePage: true, onChatClick });

      const link = dom.window.document.querySelector('a[data-timestamp]');
      link?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

      expect(onChatClick).toHaveBeenCalledWith(15000);
    });

    it('prevents default navigation when samePage is true', async () => {
      const { dom, module } = loadTimestampNav();
      dom.window.document.body.innerHTML = `
        <div id="summary-pane">
          <a href="#t-5000" data-timestamp="5000">[00:05]</a>
        </div>
      `;

      module.init({ samePage: true, onSummaryClick: () => {} });

      const link = dom.window.document.querySelector('a[data-timestamp]');
      // JSDOM MouseEvent does not support defaultPrevented reliably.
      // Instead, spy on Event.preventDefault to verify it was called.
      let preventDefaultCalled = false;
      const originalPreventDefault = dom.window.Event.prototype.preventDefault;
      dom.window.Event.prototype.preventDefault = function() {
        preventDefaultCalled = true;
        originalPreventDefault.call(this);
      };

      link?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

      expect(preventDefaultCalled).toBe(true);

      // Restore
      dom.window.Event.prototype.preventDefault = originalPreventDefault;
    });

    it('does not intercept links outside known containers', async () => {
      const { dom, module } = loadTimestampNav();
      dom.window.document.body.innerHTML = `
        <div id="unknown-container">
          <a href="#t-5000" data-timestamp="5000">[00:05]</a>
        </div>
      `;

      const onSummaryClick = vi.fn();
      module.init({ samePage: true, onSummaryClick });

      const link = dom.window.document.querySelector('a[data-timestamp]');
      link?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

      expect(onSummaryClick).not.toHaveBeenCalled();
    });
  });

  describe('samePage=false pass-through mode', () => {
    it('does not prevent default when samePage is false', async () => {
      const { dom, module } = loadTimestampNav();
      dom.window.document.body.innerHTML = `
        <div id="summary-pane">
          <a href="/signals/abc123#t-5000" data-timestamp="5000">[00:05]</a>
        </div>
      `;

      const onSummaryClick = vi.fn();
      module.init({ samePage: false, onSummaryClick });

      const link = dom.window.document.querySelector('a[data-timestamp]');
      const event = new dom.window.MouseEvent('click', { bubbles: true });
      link?.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);
      expect(onSummaryClick).not.toHaveBeenCalled();
    });
  });

  describe('dynamic content support', () => {
    it('handles links added after init via document-level delegation', async () => {
      const { dom, module } = loadTimestampNav();
      dom.window.document.body.innerHTML = `<div id="summary-pane"></div>`;

      const onSummaryClick = vi.fn();
      module.init({ samePage: true, onSummaryClick });

      // Add link AFTER init
      const pane = dom.window.document.getElementById('summary-pane');
      const a = dom.window.document.createElement('a');
      a.setAttribute('href', '#t-20000');
      a.setAttribute('data-timestamp', '20000');
      a.textContent = '[00:20]';
      pane?.appendChild(a);

      a.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

      expect(onSummaryClick).toHaveBeenCalledWith(20000);
    });
  });
});