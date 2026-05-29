const { test, expect } = require('./fixtures/server-fixture');

test('debug topics table HTML', async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/admin`);
  
  // Click Topics tab
  await page.click('button:has-text("Topics")');
  await page.waitForTimeout(1000);
  
  const html = await page.locator('table').first().innerHTML();
  console.log('=== TABLE HTML ===');
  console.log(html);
});

test('debug cell visibility', async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/admin`);
  await page.click('button:has-text("Topics")');
  await page.waitForTimeout(1000);
  
  // Try all ways to find the 'mtg' text
  const cells = page.locator('td');
  console.log('Total td count:', await cells.count());
  
  for (let i = 0; i < await cells.count(); i++) {
    const cell = cells.nth(i);
    const text = await cell.textContent();
    console.log(`Cell ${i}: "${text}"`);
  }
  
  // Try getByRole
  try {
    const mtgCell = page.getByRole('cell', { name: 'mtg', exact: true });
    const count = await mtgCell.count();
    console.log('getByRole mtg count:', count);
    if (count > 0) {
      console.log('is visible:', await mtgCell.isVisible());
    }
  } catch(e) {
    console.log('getByRole error:', e.message);
  }
  
  // Try locator with text
  try {
    const mtgL = page.locator('td').filter({ hasText: 'mtg' });
    const c2 = await mtgL.count();
    console.log('locator td hasText mtg count:', c2);
    if (c2 > 0) {
      console.log('is visible:', await mtgL.nth(0).isVisible());
    }
  } catch(e) {
    console.log('locator error:', e.message);
  }
});
