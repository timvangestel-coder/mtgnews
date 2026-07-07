import { expect } from '@playwright/test';
import { test } from './fixtures/server-fixture';
import Database from 'better-sqlite3';

const detailTranscriptDebug = JSON.stringify([
  { time: 0, text: 'Hello welcome to the show.' },
  { time: 45000, text: 'Today we discuss MTG news.' }
]);
const detailSummaryDebug = 'Welcome intro [T:0]. MTG discussion [T:45].';

function seedChatSignalDebug(db: Database.Database) {
  db.prepare(
    `INSERT OR REPLACE INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, sentiment_label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('vid_chat', 'UC_test_channel_1', 'Chat Test Signal', '2026-05-10T12:00:00Z', detailTranscriptDebug, detailSummaryDebug, 4, 'positive', Date.now());
}

test.describe('Debug Script Extraction', () => {
  test.beforeEach(({ db }) => {
    seedChatSignalDebug(db);
  });

  test('check raw HTML for script extraction order', async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/signals/vid_chat`);
    await page.waitForTimeout(2000);

    const html = await page.content();

    const hasChatPanelFunction = html.includes('function chatPanel');
    const alpinePos = html.indexOf('alpinejs');
    const chatPanelPos = html.indexOf('function chatPanel');

    console.log('=== KEY FINDINGS ===');
    console.log('Has chatPanel function:', hasChatPanelFunction);
    console.log('Alpine script position:', alpinePos);
    console.log('chatPanel function position:', chatPanelPos);
    if (hasChatPanelFunction && alpinePos > 0 && chatPanelPos > 0) {
      console.log('chatPanel BEFORE Alpine:', chatPanelPos < alpinePos);
    }

    expect(true).toBe(true);
  });
});