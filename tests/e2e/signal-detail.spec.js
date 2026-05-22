const { test, expect } = require('./fixtures/server-fixture');
const { createSignalDetailPage } = require('./fixtures/signal-detail-page');

const detailTranscript = JSON.stringify([
  { time: 0, text: 'Hello welcome to the show.' },
  { time: 45000, text: 'Today we discuss MTG news.' }
]);
const detailSummary = 'Welcome intro [T:0]. MTG discussion [T:45].';

function seedDetailSignal(db) {
  db.prepare(
    `INSERT OR REPLACE INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, sentiment_label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('vid_detail', 'UC_test_channel_1', 'Detail Test Signal', '2026-05-10T12:00:00Z', detailTranscript, detailSummary, 4, 'positive', Date.now());
}

function seedXssSignal(db) {
  const xssSummary = '<script>alert("xss")</script> Bad summary [T:0].';
  db.prepare(
    `INSERT OR REPLACE INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, sentiment_label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('vid_xss', 'UC_test_channel_1', 'XSS Test Signal', '2026-05-10T12:00:00Z', detailTranscript, xssSummary, 3, 'neutral', Date.now());
}

test.describe('Signal Detail', () => {

  test.beforeEach(({ db }) => {
    seedDetailSignal(db);
  });

  test('header renders signal title, channel badge, and published date', async ({ page, baseUrl }) => {
    const sd = createSignalDetailPage(page);
    await sd.goto('vid_detail', baseUrl);
    await sd.expectTitle('Detail Test Signal');
    await sd.expectChannelBadge('Test Channel 1');
    await sd.expectPublishedDateVisible();
  });

  // -- Three-state layout tests (Issue #32) --

  test('page loads in summary state with summary visible and transcript hidden', async ({ page, baseUrl }) => {
    const sd = createSignalDetailPage(page);
    await sd.goto('vid_detail', baseUrl);

    // DOM-only: summary visible, transcript hidden via computed style
    await sd.expectSummaryVisible();
    await sd.expectKeyTakeawaysVisible();
    await sd.expectTranscriptHidden();
  });

  test('toggle button switches to transcript state', async ({ page, baseUrl }) => {
    const sd = createSignalDetailPage(page);
    await sd.goto('vid_detail', baseUrl);

    // Click Transcript toggle
    await sd.setViewState('transcript');

    // DOM-only: transcript visible, summary hidden
    await sd.expectTranscriptVisible();
    await sd.expectSummaryHidden();
  });

  test('toggle button switches to split state with both panes visible', async ({ page, baseUrl }) => {
    const sd = createSignalDetailPage(page);
    await sd.goto('vid_detail', baseUrl);

    await sd.setViewState('split');

    // DOM-only: both panes visible, transcript taller
    await sd.expectSplitMode();
  });

  // -- Pill badge / timestamp linking tests (Issue #33) --

  test('summary timestamp pill click enters split mode and scrolls transcript to segment', async ({ page, baseUrl }) => {
    const sd = createSignalDetailPage(page);
    await sd.goto('vid_detail', baseUrl);

    // Click [T:45] pill (data-timestamp="45000")
    await sd.clickSummaryPill(45000);

    // DOM-only: split mode, segment visible
    await sd.expectSplitMode();
    await sd.expectSegmentVisible(45000);
    await sd.expectSegmentText(45000, 'Today we discuss MTG news.');
  });

  test('transcript timestamp pill click scrolls summary to matching pill', async ({ page, baseUrl }) => {
    const sd = createSignalDetailPage(page);
    await sd.goto('vid_detail', baseUrl);

    // Go to split mode first
    await sd.setViewState('split');

    // Click transcript pill for T:0
    await sd.clickTranscriptPill(0);

    // DOM-only: still split mode
    await sd.expectSplitMode();

    // Summary pill visible
    const summaryPill = page.locator('#summary-pane a[data-timestamp="0"]');
    await expect(summaryPill).toBeVisible();
  });

  test('closest-match fallback when exact timestamp has no match', async ({ page, baseUrl, db }) => {
    // Seed signal with summary timestamp no exact transcript match
    const noMatchSummary = 'Some point [T:30] discussed.';
    const noMatchTranscript = JSON.stringify([
      { time: 0, text: 'Hello welcome.' },
      { time: 45000, text: 'MTG news today.' }
    ]);

    db.prepare(
      `INSERT OR REPLACE INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, sentiment_label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('vid_nomatch', 'UC_test_channel_1', 'No Match Signal', '2026-05-10T12:00:00Z', noMatchTranscript, noMatchSummary, 4, 'positive', Date.now());

    const sd = createSignalDetailPage(page);
    await sd.goto('vid_nomatch', baseUrl);

    // Click [T:30] pill (30000ms) - no exact match (only 0 and 45000)
    await sd.clickSummaryPill(30000);

    // DOM-only: split mode
    await sd.expectSplitMode();

    // Closest segment (t-45000 at diff=15000 vs t-0 at diff=30000) visible
    await sd.expectSegmentVisible(45000);
  });

  // -- XSS test --

  test('XSS content in summaries is escaped and not executed', async ({ page, baseUrl, db }) => {
    seedXssSignal(db);

    let dialogShown = false;
    page.on('dialog', (d) => { dialogShown = true; d.dismiss(); });

    await page.goto(`${baseUrl}/signals/vid_xss`);
    await expect(page.locator('h2')).toContainText('XSS Test Signal');

    const scriptTagCount = await page.locator('[class*="prose"] script').count();
    expect(scriptTagCount).toBe(0);

    // Verify HTML entities are escaped in the rendered output
    const innerHtml = await page.locator('[class*="prose"]').innerHTML();
    // Script tags should be escaped, not rendered as actual elements
    expect(innerHtml).not.toContain('<script>');
    expect(innerHtml).toMatch(/script/);

    await page.waitForTimeout(500);
    expect(dialogShown).toBe(false);
  });

});