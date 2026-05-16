const { test, expect } = require('./fixtures/server-fixture');

test.describe('Run History', () => {
  test('page loads and renders polls list UI', async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/polls`);
    await expect(page).toHaveTitle('Run History');
    const heading = page.locator('h2').filter({ hasText: 'Run History' });
    await expect(heading).toBeVisible();

    // No poll runs seeded -> empty message
    await expect(page.locator('text=No poll runs yet.')).toBeVisible();
  });

  test('poll runs display in table when data exists', async ({ page, baseUrl, db }) => {
    const now = Date.now();

    // Seed a poll run
    db.prepare(
      `INSERT INTO poll_runs (id, triggered_at, status, new_signal_count, completed_at)
       VALUES (?, ?, 'done', ?, ?)`
    ).run(1, now, 2, now);

    // Seed progress rows
    db.prepare(
      `INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(1, 'UC_test_channel_1', 'done', 1, now);
    db.prepare(
      `INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(1, 'UC_test_channel_2', 'done', 1, now);

    await page.goto(`${baseUrl}/polls`);

    // Table row visible
    await expect(page.locator('tbody tr')).toHaveCount(1);

    // Status badge "done" visible
    await expect(page.locator('span.bg-green-600').filter({ hasText: 'done' })).toBeVisible();

    // New signal count = 2
    await expect(page.locator('td').filter({ hasText: '2' }).first()).toBeVisible();
  });

  test('poll detail page loads correctly', async ({ page, baseUrl, db }) => {
    const now = Date.now();

    // Seed a poll run
    db.prepare(
      `INSERT INTO poll_runs (id, triggered_at, status, new_signal_count, completed_at)
       VALUES (?, ?, 'done', ?, ?)`
    ).run(1, now, 2, now);

    // Seed progress rows
    db.prepare(
      `INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(1, 'UC_test_channel_1', 'done', 1, now);
    db.prepare(
      `INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(1, 'UC_test_channel_2', 'done', 1, now);

    await page.goto(`${baseUrl}/polls/1-detail`);
    await expect(page).toHaveTitle('Run #1 Detail');

    const heading = page.locator('h2').filter({ hasText: 'Run Detail' });
    await expect(heading).toBeVisible();

    // Status badge (use first to avoid strict mode violation with multiple done badges)
    await expect(page.locator('span.bg-green-600').filter({ hasText: 'done' }).first()).toBeVisible();

    // New signals count
    await expect(page.locator('text=New Signals')).toBeVisible();

    // Channel breakdown header
    const breakdownHeader = page.locator('h3').filter({ hasText: 'Channel Breakdown' });
    await expect(breakdownHeader).toBeVisible();

    // Progress table rows for 2 channels
    await expect(page.locator('tbody tr')).toHaveCount(2);
  });

  test('poll detail row is clickable from polls list', async ({ page, baseUrl, db }) => {
    const now = Date.now();

    // Seed a poll run
    db.prepare(
      `INSERT INTO poll_runs (id, triggered_at, status, new_signal_count, completed_at)
       VALUES (?, ?, 'done', ?, ?)`
    ).run(1, now, 2, now);

    db.prepare(
      `INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(1, 'UC_test_channel_1', 'done', 1, now);
    db.prepare(
      `INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(1, 'UC_test_channel_2', 'done', 1, now);

    await page.goto(`${baseUrl}/polls`);

    // Click table row (has onclick handler)
    await page.locator('tbody tr[onclick]').first().click();
    await expect(page).toHaveURL(/\/polls\/1-detail/);
    await expect(page.locator('h2').filter({ hasText: 'Run Detail' })).toBeVisible();
  });

  test('back link on detail returns to polls list', async ({ page, baseUrl, db }) => {
    const now = Date.now();

    db.prepare(
      `INSERT INTO poll_runs (id, triggered_at, status, new_signal_count, completed_at)
       VALUES (?, ?, 'done', 0, ?)`
    ).run(1, now, now);

    await page.goto(`${baseUrl}/polls/1-detail`);

    const backLink = page.locator('a:has-text("Back to Run History")');
    await expect(backLink).toBeVisible();
    await backLink.click();
    await expect(page).toHaveURL(`${baseUrl}/polls`);
  });
});