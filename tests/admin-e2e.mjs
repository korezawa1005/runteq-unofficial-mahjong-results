import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const base = process.env.TEST_URL || 'http://127.0.0.1:8011';
const browser = await chromium.launch({channel: 'chrome', headless: true});
try {
  const context = await browser.newContext({viewport: {width: 1280, height: 900}});
  const page = await context.newPage();
  await page.goto(`${base}/#members`, {waitUntil: 'networkidle'});
  assert.equal(await page.locator('#admin-setup h2').textContent(), '管理者PINを設定');
  await page.locator('#admin-setup [name=pin]').fill('2468');
  await page.locator('#admin-setup button[type=submit]').click();
  await page.waitForSelector('#member-form');
  assert.equal(await page.locator('.admin-status').textContent(), '管理者モード');

  for (const name of ['東', '南', '西', '北']) {
    await page.locator('#member-form [name=name]').fill(name);
    await page.locator('#member-form button[type=submit]').click();
    await page.waitForFunction(expected => document.querySelectorAll('.member-row').length === expected, ['東', '南', '西', '北'].indexOf(name) + 1);
    assert.equal(await page.locator('#member-form [name=name]').evaluate(input => document.activeElement === input), true);
  }

  await page.locator('#admin-logout').click();
  await page.waitForSelector('#admin-login');
  assert.equal(await page.locator('#member-form').count(), 0);
  await page.click('a[href="#record"]');
  await page.waitForSelector('#game-form');
  await page.locator('#game-form button[type=submit]').click();
  await page.waitForSelector('.stats-grid');

  await page.click('a[href="#record"]');
  await page.waitForSelector('.history');
  assert.equal(await page.locator('[data-delete]').count(), 0);
  await page.click('a[href="#members"]');
  await page.locator('#admin-login [name=pin]').fill('2468');
  await page.locator('#admin-login button[type=submit]').click();
  await page.waitForSelector('#member-form');
  await page.click('a[href="#record"]');
  await page.waitForSelector('[data-delete]');

  const outsider = await browser.newContext();
  const response = await outsider.request.post(`${base}/api/players`, {
    headers: {'Content-Type': 'application/json', 'X-Requested-With': 'HanchanRecord'},
    data: {name: '拒否される名前'},
  });
  assert.equal(response.status(), 403);
  await outsider.close();
  console.log('管理者権限ブラウザテスト: 10項目 OK');
} finally {
  await browser.close();
}
