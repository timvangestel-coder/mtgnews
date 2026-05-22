const { expect } = require('@playwright/test');

/**
 * Page object for Signal Detail page.
 * DOM-only assertions — no Alpine.$data() or framework internals.
 */
class SignalDetailPage {
  constructor(page) {
    this.page = page;
    this.summaryPane = page.locator('#summary-pane');
    this.transcriptPane = page.locator('#transcript-pane');
  }

  async goto(videoId, baseUrl) {
    await this.page.goto(`${baseUrl}/signals/${videoId}`);
    
    // Wait for Alpine CDN to load
    await this.page.waitForFunction(() => typeof window.Alpine !== 'undefined', { timeout: 15_000 });
    
    // Explicitly start Alpine - CDN sync load means DOMContentLoaded already fired in headless Chromium
    await this.page.evaluate(() => {
      try { window.Alpine.start(); } catch(e) { /* already started */ }
    });
    
    // Wait for Alpine component init() to signal ready
    await this.page.waitForFunction(() => window.__alpineReady === true, { timeout: 10_000 });
  }

  // -- view state via DOM only --

  /** Click a toggle button by label text ('Summary' | 'Transcript' | 'Split'). */
  async setViewState(state) {
    const label = state.charAt(0).toUpperCase() + state.slice(1);
    await this.page.click(`button:has-text("${label}")`);
    // wait for Alpine to apply :class + CSS transition
    await this.page.waitForTimeout(1100);
  }

  /** Current view state inferred from DOM visibility. */
  async getCurrentViewState() {
    const summaryVisible = await this.summaryPane.isVisible();
    const transcriptVisible = await this.transcriptPane.isVisible();

    if (summaryVisible && !transcriptVisible) return 'summary';
    if (!summaryVisible && transcriptVisible) return 'transcript';
    if (summaryVisible && transcriptVisible) return 'split';
    return 'split';
  }

  // -- pane assertions --

  async expectSummaryVisible() {
    await expect(this.summaryPane).toBeVisible();
    const box = await this.summaryPane.boundingBox();
    expect(box?.height).toBeGreaterThan(30);
  }

  /** Summary pane collapsed via flex-[0_0_0] + overflow-hidden (no longer uses `hidden` class). */
  async expectSummaryHidden() {
    const box = await this.summaryPane.boundingBox();
    expect(box?.height).toBe(0);
  }

  async expectTranscriptVisible() {
    await expect(this.transcriptPane).toBeVisible();
    const box = await this.transcriptPane.boundingBox();
    expect(box?.height).toBeGreaterThan(50);
  }

  /** Transcript pane collapsed via flex-[0_0_0] + overflow-hidden (no longer uses `hidden` class). */
  async expectTranscriptHidden() {
    const box = await this.transcriptPane.boundingBox();
    expect(box?.height).toBe(0);
  }

  async expectSplitMode() {
    await this.expectSummaryVisible();
    await this.expectTranscriptVisible();
    const sBox = await this.summaryPane.boundingBox();
    const tBox = await this.transcriptPane.boundingBox();
    expect(tBox.height).toBeGreaterThan(sBox.height);
  }

  /** Returns { summaryHeight, transcriptHeight } in px. */
  async getPaneHeights() {
    const sBox = await this.summaryPane.boundingBox();
    const tBox = await this.transcriptPane.boundingBox();
    return {
      summaryHeight: sBox?.height ?? 0,
      transcriptHeight: tBox?.height ?? 0,
    };
  }

  // -- timestamp pill interactions --

  /** Click a summary pill by data-timestamp value (ms). */
  async clickSummaryPill(ms) {
    const pill = this.page.locator(`#summary-pane a[data-timestamp="${ms}"]`);
    await expect(pill).toBeVisible();
    await pill.click();
    await this.page.waitForTimeout(1500);
  }

  /** Click a transcript pill by data-timestamp value (ms). */
  async clickTranscriptPill(ms) {
    const pill = this.page.locator(`#transcript-pane a[data-timestamp="${ms}"]`);
    await expect(pill).toBeVisible();
    await pill.click();
    await this.page.waitForTimeout(500);
  }

  // -- segment assertions --

  /** Check transcript segment at given ms is visible. */
  async expectSegmentVisible(ms) {
    const segment = this.page.locator(`#t-${ms}`);
    await expect(segment).toBeVisible();
  }

  /** Check transcript segment contains expected text. */
  async expectSegmentText(ms, text) {
    const segment = this.page.locator(`#t-${ms}`);
    await expect(segment).toContainText(text);
  }

  // -- header assertions --

  async expectTitle(title) {
    await expect(this.page.locator('h2')).toContainText(title);
  }

  async expectChannelBadge(name) {
    await expect(this.page.locator('.bg-blue-100')).toContainText(name);
  }

  async expectPublishedDateVisible() {
    await expect(this.page.locator('time')).toBeVisible();
  }

  // -- summary content --

  async expectKeyTakeawaysVisible() {
    await expect(this.page.locator('text=Key Takeaways')).toBeVisible();
  }
}

function createSignalDetailPage(page) {
  return new SignalDetailPage(page);
}

module.exports = { SignalDetailPage, createSignalDetailPage };