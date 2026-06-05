import { test, expect } from './fixtures/server-fixture';

test.describe('Admin Topic Inline Edit', () => {
  test('should show console errors when editing a topic', async ({ page, baseUrl }) => {
    const consoleLogs: string[] = [];
    const browserErrors: string[] = [];

    page.on('console', msg => consoleLogs.push(`${msg.type()}: ${msg.text()}`));
    page.on('pageerror', err => browserErrors.push(err.message));

    // Go to admin topics tab
    await page.goto(`${baseUrl}/admin?tab=topics`);
    await page.waitForTimeout(1000); // Wait for Alpine.js to initialize

    console.log('=== Console Logs ===');
    console.log(consoleLogs.join('\n'));
    console.log('=== Browser Errors ===');
    console.log(browserErrors.join('\n'));

    // Check if topics table is visible
    const rows = page.locator('tr[data-topic-id]');
    const rowCount = await rows.count();
    console.log(`Found ${rowCount} topic row(s)`);

    expect(rowCount).toBeGreaterThan(0, 'Topics table should have at least one row');

    // Check first row is visible
    await expect(rows.first()).toBeVisible({ timeout: 5000 });

    // Click Edit button on first row
    const editButton = rows.first().locator('button:text("Edit")').first();
    if (await editButton.isVisible()) {
      await editButton.click();
      await page.waitForTimeout(500);

      // Check that edit inputs are visible
      const inputs = rows.first().locator('input[x-cloak], input[name="key"]');
      console.log(`Edit inputs count: ${await inputs.count()}`);

      // Click Save button
      const saveButton = rows.first().locator('button:text("Save")').first();
      if (await saveButton.isVisible()) {
        await saveButton.click();
        await page.waitForTimeout(2000);

        // Check for errors after save
        console.log('\n=== After Save ===');
        console.log('Console Logs:', consoleLogs.filter(l => l.includes('error') || l.includes('Error')).join('\n'));
        console.log('Browser Errors:', browserErrors.join('\n'));

        // Row should still be visible and in view mode (not edit mode)
        await expect(rows.first()).toBeVisible();
      }
    }

    // Final assertion: no uncaught errors
    expect(browserErrors.length).toBe(0, `Should have no browser errors, got: ${browserErrors.join(', ')}`);
  });
});