const { test, expect } = require('./fixtures/server-fixture');

test.describe('Admin Panel', () => {
  test('page loads and renders admin UI', async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/admin`);
    await expect(page).toHaveTitle('Admin Panel');
    const heading = page.locator('h2').filter({ hasText: 'Admin Panel' });
    await expect(heading).toBeVisible();
  });

  test('watchlist displays seeded channels', async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/admin`);
    
    // WatchList section header visible
    const watchlistHeader = page.locator('h3').filter({ hasText: 'WatchList' });
    await expect(watchlistHeader).toBeVisible();

    // 2 seeded channels rendered as rows
    const channelRows = page.locator('.bg-gray-50.rounded');
    await expect(async () => {
      expect(await channelRows.count()).toBeGreaterThanOrEqual(2);
    }).toPass();

    // Channel display names visible
    await expect(page.locator('.font-medium').filter({ hasText: 'Test Channel 1' })).toBeVisible();
    await expect(page.locator('.font-medium').filter({ hasText: 'Test Channel 2' })).toBeVisible();

    // Active status labels
    await expect(page.locator('text=Active')).toHaveCount(2);
  });

  test('add channel form is visible', async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/admin`);

    const addHeader = page.locator('h3').filter({ hasText: 'Add Channel' });
    await expect(addHeader).toBeVisible();

    const channelInput = page.locator('input[type="text"][name="channel_id"]');
    await expect(channelInput).toBeVisible();

    const addButton = page.locator('button:has-text("Add")');
    await expect(addButton).toBeVisible();
  });

  test('progress widget is visible', async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/admin`);

    const widget = page.locator('#progress-widget');
    await expect(widget).toBeVisible();

    // No poll run seeded -> "No active poll run." message
    await expect(page.locator('text=No active poll run.')).toBeVisible();
  });

  test('run poll button is visible', async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/admin`);
    
    const pollButton = page.locator('form[action="/admin/poll/trigger"] button');
    await expect(pollButton).toBeVisible();
    await expect(pollButton).toContainText('Run Poll Now');
  });
});