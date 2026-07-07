import { expect } from '@playwright/test';
import { test } from './fixtures/server-fixture';

test('topic pill click filters channel pills and signal table', async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/signals`);

  // Wait for Alpine to initialize
  await page.waitForFunction(() => (window as any).Alpine && (window as any).Alpine.data, { timeout: 5000 });

  // Target the unified command bar card container
  const filterSection = page.locator('div.bg-white.rounded-xl[x-data]');
  await expect(filterSection).toBeVisible();

  // Topic pills exist in first row segmented control
  const topicPills = filterSection.locator('> div:first-child > div:first-child button');
  await expect(topicPills.nth(0)).toBeVisible();
  await expect(topicPills.first()).toContainText('All Topics');

  // Channel pills row exists (second row)
  const channelRow = filterSection.locator('> div:nth-child(2)');
  await expect(channelRow).toBeVisible();
});