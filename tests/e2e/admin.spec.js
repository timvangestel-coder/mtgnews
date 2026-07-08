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
    const channelRows = page.locator('[data-channel-id]');
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

    // Click Polling tab (default is Channels)
    await page.click('button:has-text("Polling")');
    
    const widget = page.locator('#progress-widget');
    await expect(widget).toBeVisible();

    // No poll run seeded -> "No poll runs yet." message
    await expect(page.locator('text=No poll runs yet.')).toBeVisible();
  });

  test('run poll button is visible', async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/admin`);
    
    // Click Polling tab (default is Channels)
    await page.click('button:has-text("Polling")');
    
    const pollButton = page.locator('form[hx-post="/admin/poll/trigger"] button');
    await expect(pollButton).toBeVisible();
    await expect(pollButton).toContainText('Run Poll Now');
  });

  test('topics tab shows seeded topics', async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/admin`);
    
    // Click Topics tab
    await page.click('button:has-text("Topics")');
    await expect(page.locator('h3').filter({ hasText: 'Topics' })).toBeVisible();
    
    // Table renders with seeded topic data — use locator since getByRole cell name matching unreliable
    const table = page.locator('table');
    await expect(table).toBeVisible();
    
    // Find mtg key cell using tbody row + font-mono span (exact match in Key column)
    const mtgKeyCell = page.locator('tbody tr').filter({ has: page.locator('.font-mono', { hasText: 'mtg' }) });
    await expect(mtgKeyCell).toBeVisible();
    
    // Find MTG short name cell (second td in same row)
    const mtgRow = page.locator('tbody tr').filter({ has: page.locator('.font-mono', { hasText: 'mtg' }) });
    await expect(mtgRow.locator('td').nth(1).filter({ hasText: 'MTG' })).toBeVisible();
  });

  test('edit topic inline — click Edit transforms cells to inputs in same row', async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/admin`);
    
    // Switch to Topics tab
    await page.click('button:has-text("Topics")');
    
    // Find the MTG topic row by key cell (font-mono span = mtg)
    const mtgRow = page.locator('tbody tr').filter({ has: page.locator('.font-mono', { hasText: 'mtg' }) });
    await expect(mtgRow).toBeVisible();
    
    // Click Edit button in that row
    await mtgRow.locator('button:has-text("Edit")').click();
    
    // Row count should NOT increase — editing happens in-place, no extra <tr> added
    const rowCount = await page.locator('tbody tr').count();
    expect(rowCount).toBeLessThanOrEqual(2); // mtg + ai only
    
    // Key input should be visible within the same row
    const keyInput = mtgRow.locator('input[name="key"]');
    await expect(keyInput).toBeVisible();
  });

  test('edit and save topic inline', async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/admin`);
    
    // Switch to Topics tab
    await page.click('button:has-text("Topics")');
    
    const mtgRow = page.locator('tbody tr').filter({ has: page.locator('.font-mono', { hasText: 'mtg' }) });
    await mtgRow.locator('button:has-text("Edit")').click();
    
    // Fill in the key input within this row's form
    const keyInput = mtgRow.locator('input[name="key"]');
    await expect(keyInput).toBeVisible();
    await keyInput.fill('mtg-renamed');
    
    // Update short_name
    const nameInput = mtgRow.locator('input[name="short_name"]');
    await nameInput.fill('MTG Renamed');
    
    // Save — HTMX POST, no redirect (Issue #64)
    await mtgRow.locator('button:has-text("Save")').click();
    await page.waitForTimeout(500);
    
    // Still on Topics tab (no reload)
    const topicsHeader = page.locator('h3').filter({ hasText: 'Topics' });
    await expect(topicsHeader).toBeVisible();
    
    // Row should have exited edit mode and show updated values
    const renamedRow = page.locator('tbody tr').filter({ has: page.locator('.font-mono', { hasText: 'mtg-renamed' }) });
    await expect(renamedRow).toBeVisible({ timeout: 5000 });
    await expect(renamedRow.locator('td').nth(1).filter({ hasText: 'MTG Renamed' })).toBeVisible({ timeout: 5000 });
  });

  test('click outside cancels editing', async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/admin`);

    // Switch to Topics tab
    await page.click('button:has-text("Topics")');

    const mtgRow = page.locator('tbody tr').filter({ has: page.locator('.font-mono', { hasText: 'mtg' }) });
    await mtgRow.locator('button:has-text("Edit")').click();

    // Verify edit mode active (input visible)
    const keyInput = mtgRow.locator('input[name="key"]');
    await expect(keyInput).toBeVisible();

    // Click outside the editing row -> cancels via @click.outside on the <span>
    // Add Topic header is in Topics tab and outside the table row
    await page.click('h4:has-text("Add Topic")', { force: true });

    // Edit mode should be gone, original display restored
    const restoredMtg = page.locator('.font-mono', { hasText: 'mtg' });
    await expect(restoredMtg).toBeVisible({ timeout: 5000 });
  });

  test('cancel edit reverts to original values', async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/admin`);
    
    // Switch to Topics tab
    await page.click('button:has-text("Topics")');
    
    const mtgRow = page.locator('tbody tr').filter({ has: page.locator('.font-mono', { hasText: 'mtg' }) });
    await mtgRow.locator('button:has-text("Edit")').click();
    
    // Change key value in the row-scoped input
    const keyInput = mtgRow.locator('input[name="key"]');
    await keyInput.fill('mtg-changed');
    
    // Click Cancel — inline revert, no redirect
    await mtgRow.locator('button:has-text("Cancel")').click();
    
    // Original values should be visible (inline revert within same row)
    const restoredMtg = page.locator('.font-mono', { hasText: 'mtg' });
    await expect(restoredMtg).toBeVisible({ timeout: 5000 });
    
    // The changed value should NOT appear in display cells
    const changedCell = page.locator('.font-mono', { hasText: 'mtg-changed' });
    await expect(changedCell).not.toBeVisible();
  });

  // Issue #64 — Tab state preserved on form submit (no reload)
  test.describe('Tab persistence on form submit (Issue #64)', () => {
    test('editing a Topic row and saving stays on Topics tab', async ({ page, baseUrl }) => {
      await page.goto(`${baseUrl}/admin`);
      await page.click('button:has-text("Topics")');

      const mtgRow = page.locator('tbody tr').filter({ has: page.locator('.font-mono', { hasText: 'mtg' }) });
      await mtgRow.locator('button:has-text("Edit")').click();

      const keyInput = mtgRow.locator('input[name="key"]');
      await expect(keyInput).toBeVisible();
      await keyInput.fill('mtg-tab-test');

      // Save — should NOT cause page reload or tab change
      await mtgRow.locator('button:has-text("Save")').click();
      await page.waitForTimeout(500);

      // Still on Topics tab (Topics header visible, not Channels)
      const topicsHeader = page.locator('h3').filter({ hasText: 'Topics' });
      await expect(topicsHeader).toBeVisible();
    });

    test('adding a new topic stays on Topics tab', async ({ page, baseUrl }) => {
      await page.goto(`${baseUrl}/admin`);
      await page.click('button:has-text("Topics")');

      const keyInput = page.locator('form[name="add-topic"] input[name="key"]').first();
      if (await keyInput.isVisible({ timeout: 1000 }).catch(() => false)) {
        // Form with name attribute exists
      } else {
        // Use the Add Topic form's inputs directly
      }

      const addForm = page.locator('form').filter({ hasText: 'Add Topic' });
      await addForm.locator('input[name="key"]').fill('tab-test-key');
      await addForm.locator('input[name="short_name"]').fill('Tab Test');
      await addForm.locator('button[type="submit"]').click();
      await page.waitForTimeout(500);

      // Still on Topics tab
      const topicsHeader = page.locator('h3').filter({ hasText: 'Topics' });
      await expect(topicsHeader).toBeVisible();
    });

    test('toggling channel active stays on Channels tab', async ({ page, baseUrl }) => {
      await page.goto(`${baseUrl}/admin`);
      // Default is Channels tab — click to confirm
      await page.click('button:has-text("Channels")');

      // Toggle first channel's checkbox (use force:true to bypass sr-only + overlay div pointer intercept)
      const firstToggle = page.locator('[data-channel-id]').first().locator('input[type="checkbox"]');
      if (await firstToggle.isChecked()) {
        await firstToggle.click({ force: true });
      }
      await page.waitForTimeout(500);

      // Still on Channels tab (WatchList header visible)
      const watchlistHeader = page.locator('h3').filter({ hasText: 'WatchList' });
      await expect(watchlistHeader).toBeVisible();
    });

    test('poll trigger stays on Polling tab', async ({ page, baseUrl }) => {
      await page.goto(`${baseUrl}/admin`);
      await page.click('button:has-text("Polling")');

      const pollButton = page.locator('form').filter({ hasText: 'Run Poll Now' }).locator('button[type="submit"]');
      await pollButton.click();
      await page.waitForTimeout(500);

      // Still on Polling tab (progress widget visible)
      const progressWidget = page.locator('#progress-widget');
      await expect(progressWidget).toBeVisible();
    });
  });
});