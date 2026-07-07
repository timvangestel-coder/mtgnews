const { test, expect } = require('./fixtures/server-fixture');

// Card selector: each signal is a div with cursor-pointer and onclick navigating to /signals/:id
const cardSelector = 'div.cursor-pointer[onclick*="/signals/"]';

test.describe('Signal Viewer', () => {

  test('signal list renders with signal titles from seeded fixture data', async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/signals`);
    // Cards replace table rows
    await expect(page.locator(cardSelector)).toHaveCount(3);
    // View renders generated_title || title (not summary) in the card
    await expect(page.getByText('Signal One')).toBeVisible();
    await expect(page.getByText('Signal Two')).toBeVisible();
    await expect(page.getByText('Signal Three')).toBeVisible();
  });

  test('channel filter pill filters signals when clicked', async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/signals`);
    // wait for HTMX + Alpine CDN scripts to load
    await Promise.all([
      page.waitForFunction(() => typeof window.htmx !== 'undefined'),
      page.waitForFunction(() => typeof window.Alpine !== 'undefined'),
    ]);
    // trigger filter via htmx.ajax (same as pill @click handler)
    await page.evaluate(() => {
      htmx.ajax('GET', '/signals?channelId=UC_test_channel_1&htmx=true', { target: '#signals-table' });
    });
    // wait for HTMX swap: card count must change from 3
    await expect(async () => {
      await expect(page.locator(cardSelector)).not.toHaveCount(3);
    }).toPass({ timeout: 10000 });
    // should show only 2 signals from channel 1
    await expect(page.locator(cardSelector)).toHaveCount(2);
    // Signal Three is from UC_test_channel_2, so it should be filtered out
    await expect(page.getByText('Signal Three')).toBeHidden();
  });

  test('sentiment badges display correct colors', async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/signals`);
    // Sentiment badge is a div (not span) with rounded-full and token colors
    // Score 1 -> bg-danger-100 (token color)
    await expect(page.locator('div.rounded-full.bg-danger-100')).toBeVisible();
    // Score 5 -> bg-success-100 (token color)
    await expect(page.locator('div.rounded-full.bg-success-100')).toBeVisible();
  });

  test('signal cards are clickable and navigate to /signals/:id', async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/signals`);
    // Click first signal card (div with cursor-pointer and onclick)
    await page.locator(cardSelector).first().click();
    await expect(page).toHaveURL(/\/signals\/vid_/);
    // Signal detail page uses h2 for the title
    await expect(page.locator('h2')).toBeVisible();
  });

  test('pagination links load correct page via HTMX', async ({ page, baseUrl, db }) => {
    // seed 26 more signals -> 2 pages (29 total, limit 25)
    const now = Date.now();
    for (let i = 4; i <= 29; i++) {
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, sentiment_label, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(`vid_${i}`, 'UC_test_channel_1', `Signal ${i}`, `2026-05-01T00:00:00Z`, '[]', `Summary for signal ${i}`, 3, 'neutral', now);
    }

    await page.goto(`${baseUrl}/signals`);
    // page 1 shows 25 cards
    await expect(page.locator(cardSelector)).toHaveCount(25);

    // click Next button
    await page.click('button:has-text("Next")');
    await page.waitForTimeout(500);
    // page 2 shows remaining 4
    await expect(page.locator(cardSelector)).toHaveCount(4);
  });
});