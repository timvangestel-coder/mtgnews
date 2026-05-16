const { test, expect } = require('./fixtures/server-fixture');

test('smoke - /signals page loads', async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/signals`);
  await expect(page).toHaveTitle('Signals');
  const heading = page.locator('h2').filter({ hasText: 'Signals' });
  await expect(heading).toBeVisible();
});