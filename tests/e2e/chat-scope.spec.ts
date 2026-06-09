/**
 * Chat scope E2E tests — architecture improvement (Candidate 2).
 *
 * Verifies observable browser behavior for the ScopeSource module:
 * - Module is loaded and available on window
 * - fromCurrentURL reads correctly from URL query params
 * - buildHistoryURL produces correct URLs
 * - buildAskBody produces correct POST bodies
 *
 * These tests verify the ScopeSource deep module works in the real browser
 * environment. They use page.goto with explicit query params to test
 * scope reading, rather than relying on Alpine filter pill interactions.
 */
import { test, expect } from './fixtures/server-fixture';

test.describe('ScopeSource E2E — browser behavior', () => {
  test('ScopeSource module is loaded and available on window', async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/signals`);
    await page.waitForSelector('#signals-table');

    const hasScopeSource = await page.evaluate(() => 
      typeof (window as any).ScopeSource === 'object' &&
      typeof (window as any).ScopeSource.fromCurrentURL === 'function' &&
      typeof (window as any).ScopeSource.buildHistoryURL === 'function' &&
      typeof (window as any).ScopeSource.buildAskBody === 'function'
    );
    expect(hasScopeSource).toBe(true);
  });

  test('fromCurrentURL returns empty scope when no query params', async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/signals`);
    await page.waitForSelector('#signals-table');

    const scope = await page.evaluate(() => 
      (window as any).ScopeSource.fromCurrentURL()
    );
    expect(scope.topicKey).toBeUndefined();
    expect(scope.channelId).toBeUndefined();
    expect(scope.includeIrrelevant).toBe(false);
  });

  test('fromCurrentURL reads topicKey from URL query params', async ({ page, baseUrl }) => {
    // Navigate directly with topicKey param (simulates filter pill state)
    await page.goto(`${baseUrl}/signals?topicKey=mtg`);
    await page.waitForSelector('#signals-table');

    const scope = await page.evaluate(() => 
      (window as any).ScopeSource.fromCurrentURL()
    );
    expect(scope.topicKey).toBe('mtg');
  });

  test('fromCurrentURL reads channelId from URL query params', async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/signals?topicKey=mtg&channelId=UC_test_channel_1`);
    await page.waitForSelector('#signals-table');

    const scope = await page.evaluate(() => 
      (window as any).ScopeSource.fromCurrentURL()
    );
    expect(scope.topicKey).toBe('mtg');
    expect(scope.channelId).toBe('UC_test_channel_1');
  });

  test('fromCurrentURL preserves empty string topicKey as list-scope indicator', async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/signals?topicKey=`);
    await page.waitForSelector('#signals-table');

    const scope = await page.evaluate(() => 
      (window as any).ScopeSource.fromCurrentURL()
    );
    // Empty string topicKey is a valid list-scope indicator meaning "all signals"
    expect(scope.topicKey).toBe('');
  });

  test('fromCurrentURL returns undefined when topicKey param is absent', async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/signals`);
    await page.waitForSelector('#signals-table');

    const scope = await page.evaluate(() => 
      (window as any).ScopeSource.fromCurrentURL()
    );
    // No topicKey param at all → undefined (not a list-scope filter)
    expect(scope.topicKey).toBeUndefined();
  });

  test('buildHistoryURL produces correct URL with topicKey', async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/signals`);
    await page.waitForSelector('#signals-table');

    const url = await page.evaluate(() => {
      return (window as any).ScopeSource.buildHistoryURL({ topicKey: 'mtg' });
    });
    expect(url).toBe('/chat/history?topicKey=mtg');
  });

  test('buildHistoryURL produces correct URL with signalVideoId', async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/signals`);
    await page.waitForSelector('#signals-table');

    const url = await page.evaluate(() => {
      return (window as any).ScopeSource.buildHistoryURL({ signalVideoId: 'vid_1' });
    });
    expect(url).toBe('/chat/history?signalVideoId=vid_1');
  });

  test('buildAskBody produces correct body for list-scoped chat', async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/signals`);
    await page.waitForSelector('#signals-table');

    const body = await page.evaluate(() => {
      return (window as any).ScopeSource.buildAskBody('test question', { topicKey: 'mtg' });
    });
    expect(body.question).toBe('test question');
    expect(body.topicKey).toBe('mtg');
  });

  test('buildAskBody produces correct body for per-signal chat', async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/signals`);
    await page.waitForSelector('#signals-table');

    const body = await page.evaluate(() => {
      return (window as any).ScopeSource.buildAskBody('test question', { signalVideoId: 'vid_1' });
    });
    expect(body.question).toBe('test question');
    expect(body.signalVideoId).toBe('vid_1');
    expect(body.topicKey).toBeUndefined();
  });

  test('data-signal-count element exists in signals table', async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/signals`);
    await page.waitForSelector('#signals-table');

    const count = await page.locator('[data-signal-count]').textContent();
    expect(count).toBeTruthy();
    const num = parseInt(count!, 10);
    expect(num).toBeGreaterThan(0);
  });
});