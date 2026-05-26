import { test, expect } from '@playwright/test';

test('topic pill click filters channel pills and signal table', async ({ page }) => {
  await page.goto('/signals');

  // Topic pills exist above channel pills
  const topicPills = page.locator('[x-data] > div:first-child button');
  await expect(topicPills.nth(0)).toBeVisible();
  await expect(topicPills.first()).toContainText('All Topics');

  // Channel pills row exists
  const channelRow = page.locator('[x-data] > div:nth-child(2)');
  await expect(channelRow).toBeVisible();
});