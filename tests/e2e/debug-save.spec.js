const { test, expect } = require('./fixtures/server-fixture');

test('debug save topic', async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/admin`);
  
  // Switch to Topics tab
  await page.click('button:has-text("Topics")');
  
  const mtgRow = page.locator('tbody tr').filter({ has: page.locator('.font-mono', { hasText: 'mtg' }) });
  await mtgRow.locator('button:has-text("Edit")').click();
  
  // Fill in the key input
  const keyInput = mtgRow.locator('input[name="key"]');
  await expect(keyInput).toBeVisible();
  await keyInput.fill('mtg-renamed');
  
  // Update short_name
  const nameInput = mtgRow.locator('input[name="short_name"]');
  await nameInput.fill('MTG Renamed');
  
  // Check what submitTopicRow would see
  const jsResult = await page.evaluate(() => {
    const row = document.querySelector('tr[data-topic-id="1"]');
    if (!row) return { error: 'no row' };
    
    const inputs = {};
    ['key', 'short_name', 'filter_text'].forEach(name => {
      const input = row.querySelector('input[name="' + name + '"], textarea[name="' + name + '"]');
      inputs[name] = input ? { found: true, value: input.value } : { found: false };
    });
    
    return { id: 1, inputs };
  });
  
  console.log('submitTopicRow would send:', JSON.stringify(jsResult, null, 2));
  
  // Now try the save
  await Promise.all([
    page.waitForResponse(resp => resp.url().includes('/admin/topics/update')),
    mtgRow.locator('button:has-text("Save")').click()
  ]);
});

test('debug check db after server test', async ({ page, baseUrl }) => {
  // Use the unit test to verify updateTopic works
  console.log('Check if server.test.ts POST /admin/topics/update test passes');
});