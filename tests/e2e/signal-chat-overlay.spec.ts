const { test, expect } = require('./fixtures/server-fixture');

const detailTranscript = JSON.stringify([
  { time: 0, text: 'Hello welcome to the show.' },
  { time: 45000, text: 'Today we discuss MTG news.' }
]);
const detailSummary = 'Welcome intro [T:0]. MTG discussion [T:45].';

function seedChatSignal(db) {
  db.prepare(
    `INSERT OR REPLACE INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, sentiment_label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('vid_chat', 'UC_test_channel_1', 'Chat Test Signal', '2026-05-10T12:00:00Z', detailTranscript, detailSummary, 4, 'positive', Date.now());
}

test.describe('SignalChat UI — Overlay Panel', () => {
  test.beforeEach(({ db }) => {
    seedChatSignal(db);
  });

  test('chat toggle button visible on Signal Detail page, opens overlay panel from right', async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/signals/vid_chat`);
    await expect(page.locator('h2')).toContainText('Chat Test Signal');

    // Wait for Alpine.js to load and process all x-data components including nested ones
    // The chatPanel component has its own x-data separate from the signal-detail x-data
    await page.waitForFunction(() => {
      // Alpine must be loaded
      if (!window.Alpine) return false;
      // Wait for the chat toggle button to have no display:none (Alpine processed x-show)
      const btn = document.querySelector('[data-chat-toggle]');
      if (!btn) return false;
      const style = window.getComputedStyle(btn);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }, { timeout: 15000 });

    // Chat toggle button is visible
    const chatToggle = page.locator('[data-chat-toggle]');
    await expect(chatToggle).toBeVisible();

    // Click to open panel
    await chatToggle.click();
    await page.waitForTimeout(500); // wait for Alpine transition

    // Overlay panel becomes visible (Chat header)
    const chatPanel = page.locator('[data-chat-panel]');
    await expect(chatPanel).toBeAttached();
    await expect(page.locator('h3:has-text("Chat")')).toBeAttached();

    // Backdrop overlay is present
    await expect(page.locator('.fixed.inset-0').first()).toBeAttached();
  });

  test('panel loads existing Q&A history via HTMX when opened', async ({ page, baseUrl, db }) => {
    // Seed a chat message into the DB
    db.prepare(
      `INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, ?)`
    ).run('vid_chat', 'What is this video about?', 'It is about MTG news and updates.');

    await page.goto(`${baseUrl}/signals/vid_chat`);

    // Wait for Alpine to process x-show on the toggle button
    await page.waitForFunction(() => {
      if (!window.Alpine) return false;
      const btn = document.querySelector('[data-chat-toggle]');
      if (!btn) return false;
      const style = window.getComputedStyle(btn);
      return style.display !== 'none';
    }, { timeout: 15000 });

    // Open chat panel
    await page.locator('[data-chat-toggle]').click();
    await page.waitForTimeout(800); // wait for HTMX load + Alpine transition

    // Panel attached to DOM
    const chatPanel = page.locator('[data-chat-panel]');
    await expect(chatPanel).toBeAttached();

    // History loaded — question and answer visible (filter by text to avoid phantom entries)
    const seededQuestion = page.locator('.chat-question:has-text("What is this video about?")');
    await expect(seededQuestion).toBeAttached();
    await expect(page.locator('.chat-answer:has-text("MTG news")')).toBeAttached();
  });

  test('panel has close button and backdrop for closing', async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/signals/vid_chat`);

    // Wait for Alpine to process x-show on the toggle button
    await page.waitForFunction(() => {
      if (!window.Alpine) return false;
      const btn = document.querySelector('[data-chat-toggle]');
      if (!btn) return false;
      const style = window.getComputedStyle(btn);
      return style.display !== 'none';
    }, { timeout: 15000 });

    // Open panel
    await page.locator('[data-chat-toggle]').click();
    await page.waitForTimeout(400);
    await expect(page.locator('[data-chat-panel]')).toBeAttached();

    // Verify close button exists in panel header with @click="toggleChat"
    const closeBtn = page.locator('[data-chat-panel] > div:first-child button');
    await expect(closeBtn).toBeAttached();

    // Verify backdrop overlay exists with click handler
    const backdrop = page.locator('.fixed.inset-0.bg-black\\/20');
    await expect(backdrop).toBeAttached();

    // Verify x-show binding on panel (check attribute exists)
    const panelXShow = await page.getAttribute('[data-chat-panel]', 'x-show');
    expect(panelXShow).toBe('chatOpen');

    // Verify backdrop also has x-show
    const backdropXShow = await page.getAttribute('.fixed.inset-0.bg-black\\/20', 'x-show');
    expect(backdropXShow).toBe('chatOpen');
  });

  test('each question row has delete button that removes the pair via HTMX DELETE', async ({ page, baseUrl, db }) => {
    // Seed two chat messages
    db.prepare(
      `INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, ?)`
    ).run('vid_chat', 'Question one?', 'Answer one.');
    db.prepare(
      `INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, ?)`
    ).run('vid_chat', 'Question two?', 'Answer two.');

    await page.goto(`${baseUrl}/signals/vid_chat`);

    // Wait for Alpine to process x-show on the toggle button
    await page.waitForFunction(() => {
      if (!window.Alpine) return false;
      const btn = document.querySelector('[data-chat-toggle]');
      if (!btn) return false;
      const style = window.getComputedStyle(btn);
      return style.display !== 'none';
    }, { timeout: 15000 });

    await page.locator('[data-chat-toggle]').click();
    await page.waitForTimeout(700);

    // Two entries loaded
    await expect(page.locator('.chat-entry')).toHaveCount(2);

    // Delete first entry via HTMX DELETE — use force:true to handle 204 response
    const deleteButtons = page.locator('[data-chat-delete]');
    await deleteButtons.first().click();
    await page.waitForTimeout(500);

    // After delete, the entry should be removed from DOM
    // HTMX 204 removes target element
    await expect(page.locator('.chat-entry')).toHaveCount(1);
  });

  test('chat answer tables hide thead headers but keep tbody two-column layout', async ({ page, baseUrl, db }) => {
    // Seed a chat answer with pre-formatted HTML table (is_formatted=1) containing thead + tbody
    const answerHtml = [
      '<table>',
      '  <thead><tr><th>Timestamp</th><th>Finding</th></tr></thead>',
      '  <tbody>',
      '    <tr><td>[02:13]</td><td>Deep space relay nodes function as fueling stations</td></tr>',
      '    <tr><td>[09:40]</td><td>Scientific impossibilities are engineering challenges</td></tr>',
      '  </tbody>',
      '</table>'
    ].join('');

    db.prepare(
      `INSERT INTO signal_chat (signal_video_id, question, answer, is_formatted) VALUES (?, ?, ?, 1)`
    ).run('vid_chat', 'can you tell me the interesting topics?', answerHtml);

    await page.goto(`${baseUrl}/signals/vid_chat`);

    // Wait for Alpine to process x-show on the toggle button
    await page.waitForFunction(() => {
      if (!window.Alpine) return false;
      const btn = document.querySelector('[data-chat-toggle]');
      if (!btn) return false;
      const style = window.getComputedStyle(btn);
      return style.display !== 'none';
    }, { timeout: 15000 });

    // Open chat panel
    await page.locator('[data-chat-toggle]').click();
    await page.waitForTimeout(800);

    // History loaded — question visible
    const seededQuestion = page.locator('.chat-question:has-text("can you tell me the interesting topics?")');
    await expect(seededQuestion).toBeAttached();

    // THEAD must be hidden (display: none) within .chat-answer tables
    const theadHidden = await page.$eval('.chat-answer table thead', (el) => {
      return window.getComputedStyle(el).display === 'none';
    });
    expect(theadHidden).toBe(true);

    // TBODY rows must still be visible — two-column layout preserved
    const tbodyRows = await page.locator('.chat-answer table tbody tr');
    expect(await tbodyRows.count()).toBe(2);

    // First row cells are visible and contain expected content
    const firstRow = tbodyRows.first();
    await expect(firstRow.locator('td').first()).toContainText('02:13');
    await expect(firstRow.locator('td').last()).toContainText('Deep space relay nodes');
  });

  test('send form has input bound to Alpine and submit handler', async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/signals/vid_chat`);

    // Wait for Alpine to process x-show on the toggle button
    await page.waitForFunction(() => {
      if (!window.Alpine) return false;
      const btn = document.querySelector('[data-chat-toggle]');
      if (!btn) return false;
      const style = window.getComputedStyle(btn);
      return style.display !== 'none';
    }, { timeout: 15000 });

    await page.locator('[data-chat-toggle]').click();
    await page.waitForTimeout(400);
    await expect(page.locator('[data-chat-panel]')).toBeAttached();

    // Verify input field exists with x-model binding
    const input = page.locator('[data-chat-input]');
    await expect(input).toBeAttached();
    const xModel = await input.getAttribute('x-model');
    expect(xModel).toBe('chatInput');

    // Verify send button exists and is a submit type
    const sendBtn = page.locator('[data-chat-send]');
    await expect(sendBtn).toBeAttached();
    const btnType = await sendBtn.getAttribute('type');
    expect(btnType).toBe('submit');

    // Verify form has @submit.prevent="sendQuestion"
    const formSubmitHandler = await page.getAttribute('#chat-messages-list ~ div form', '@submit.prevent');
    expect(formSubmitHandler).toBe('sendQuestion');

    // Verify messages list container exists for appending entries
    const messagesList = page.locator('#chat-messages-list');
    await expect(messagesList).toBeAttached();
  });
});