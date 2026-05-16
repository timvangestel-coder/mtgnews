const { test, expect } = require('./fixtures/server-fixture');

const detailTranscript = JSON.stringify([
  { text: 'Hello welcome to the show.', start: 0, end: 5 },
  { text: 'Today we discuss MTG news.', start: 45, end: 50 }
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
    await page.goto(`${baseUrl}/signals/vid_detail`);
    await expect(page.locator('h2')).toContainText('Detail Test Signal');
    await expect(page.locator('.bg-blue-100')).toContainText('Test Channel 1');
    await expect(page.locator('time')).toBeVisible();
  });

  test('clicking [T:ss] timestamp link scrolls to transcription segment', async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/signals/vid_detail`);
    await page.waitForFunction(() => typeof window.Alpine !== 'undefined');

    // expand transcription first so segment is visible after scroll
    await page.click('button:has-text("Show Full Transcription")');
    await expect(page.locator('[x-show="expanded"]')).toBeVisible({ timeout: 5000 });

    // click [T:45] link in Key Takeaways
    const tLink = page.locator('a[href="#t-45"]');
    await expect(tLink).toBeVisible();
    await tLink.click();

    // segment should be visible and contain expected text
    const segment = page.locator('#t-45');
    await expect(segment).toBeVisible();
    await expect(segment).toContainText('Today we discuss MTG news.');

    // segment gets highlight class on click
    await expect(segment).toHaveClass(/transcript-segment/);
  });

  test('transcription expand/collapse button toggles visibility', async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/signals/vid_detail`);
    await page.waitForFunction(() => typeof window.Alpine !== 'undefined');

    // transcription section initially hidden
    const transcribeSection = page.locator('[x-show="expanded"]');
    await expect(transcribeSection).not.toBeVisible();

    // click "Show Full Transcription" button
    await page.click('button:has-text("Show Full Transcription")');
    await expect(transcribeSection).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#t-0')).toBeVisible();

    // click "Hide Transcription" to collapse
    await page.click('button:has-text("Hide Transcription")');
    await expect(transcribeSection).not.toBeVisible();
  });

  test('XSS content in summaries is escaped and not executed', async ({ page, baseUrl, db }) => {
    seedXssSignal(db);

    // track if alert dialog appears (would mean script executed)
    let dialogShown = false;
    page.on('dialog', (d) => { dialogShown = true; d.dismiss(); });

    await page.goto(`${baseUrl}/signals/vid_xss`);
    await expect(page.locator('h2')).toContainText('XSS Test Signal');

    // verify no <script> tags in DOM (escaped -> rendered as text)
    const scriptTagCount = await page.locator('[class*="prose"] script').count();
    expect(scriptTagCount).toBe(0);

    // verify escaped entities present in innerHTML (escaped < becomes <)
    const innerHtml = await page.locator('[class*="prose"]').innerHTML();
    expect(innerHtml).toContain('\u0026lt;script\u0026gt;');

    // no alert dialog triggered -> script not executed
    await page.waitForTimeout(500);
    expect(dialogShown).toBe(false);
  });

});