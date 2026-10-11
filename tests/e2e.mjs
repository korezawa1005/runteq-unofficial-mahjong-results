import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const browser = await chromium.launch({channel: 'chrome', headless: true});
try {
  const desktop = await browser.newPage({viewport: {width: 1440, height: 1000}});
  await desktop.goto('http://127.0.0.1:8010/#stats', {waitUntil: 'networkidle'});
  assert.equal(await desktop.locator('h1').textContent(), '個人成績');
  assert.equal(await desktop.locator('.trend-panel h2').textContent(), '着順の推移');
  assert.ok(await desktop.locator('.trend-point').count() >= 1);
  await desktop.screenshot({path: '/private/tmp/hanchan-desktop.png', fullPage: true});

  await desktop.click('a[href="#record"]');
  await desktop.waitForSelector('#game-form');
  assert.equal(await desktop.locator('.result-row').count(), 4);
  assert.equal(await desktop.locator('#score-total').textContent(), '100,000点');
  const firstPlayer = await desktop.locator('[name="player"]').first().inputValue();
  assert.equal(await desktop.locator('[name="player"]').nth(1).locator(`option[value="${firstPlayer}"]`).evaluate(option => option.disabled), false);

  const mobile = await browser.newPage({viewport: {width: 390, height: 844}});
  await mobile.goto('http://127.0.0.1:8010/#stats', {waitUntil: 'networkidle'});
  assert.equal(await mobile.locator('.dashboard-mini article').count(), 3);
  assert.equal(await mobile.locator('.rate-gauge').count(), 4);
  await mobile.screenshot({path: '/private/tmp/hanchan-mobile.png', fullPage: true});
  console.log('ブラウザテスト: 6項目 OK');
} finally {
  await browser.close();
}
