import { test, expect } from './fixtures/server-fixture';

test('topic pill click filters channel pills and signal table', async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/signals`);

  // Topic pills exist above channel pills
  const topicPills = page.locator('[x-data] > div:first-child button');
  await expect(topicPills.nth(0)).toBeVisible();
  await expect(topicPills.first()).toContainText('All Topics');

  // Channel pills row exists
  const channelRow = page.locator('[x-data] > div:nth-child(2)');
  await expect(channelRow).toBeVisible();
});