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
  assert.equal(await page.locator('a[href="#record"]').isHidden(), true);
  await page.goto(`${base}/#record`);
  await page.waitForSelector('.empty h2');
  assert.equal(await page.locator('.empty h2').textContent(), '対局の記録は管理者専用です');
  assert.equal(await page.locator('#game-form').count(), 0);

  const outsider = await browser.newContext();
  const publicState = await (await outsider.request.get(`${base}/api/state`)).json();
  const gameResponse = await outsider.request.post(`${base}/api/games`, {
    headers: {'Content-Type': 'application/json', 'X-Requested-With': 'HanchanRecord'},
    data: {
      played_at: '2026-09-25T12:00',
      results: publicState.players.slice(0, 4).map((player, index) => ({player_id: player.id, rank: index + 1, score: [40000, 30000, 20000, 10000][index]})),
    },
  });
  assert.equal(gameResponse.status(), 403);
  await page.click('a[href="#members"]');
  await page.locator('#admin-login [name=pin]').fill('2468');
  await page.locator('#admin-login button[type=submit]').click();
  await page.waitForSelector('#member-form');
  assert.equal(await page.locator('a[href="#record"]').isVisible(), true);
  await page.click('a[href="#record"]');
  await page.waitForSelector('#game-form');
  const firstPlayedAt = await page.locator('#game-form [name=played_at]').inputValue();
  await page.locator('#game-form button[type=submit]').click();
  await page.waitForSelector('#game-confirmation[open]');
  assert.equal(await page.locator('.confirmation-results > div').count(), 4);
  assert.equal(await page.locator('.duplicate-warning').count(), 0);
  await page.locator('#confirm-game-save').click();
  await page.waitForSelector('.stats-grid');
  assert.equal(await page.locator('.today-summary h2').textContent(), '本日の成績');
  assert.equal(await page.locator('.today-table tbody tr').count(), 4);
  await page.click('a[href="#record"]');
  await page.locator('#game-form [name=played_at]').fill(firstPlayedAt);
  await page.locator('#game-form button[type=submit]').click();
  await page.waitForSelector('.duplicate-warning');
  await page.locator('.confirmation-actions button[value=cancel]').click();
  await page.click('a[href="#history"]');
  await page.waitForSelector('[data-delete]');

  const response = await outsider.request.post(`${base}/api/players`, {
    headers: {'Content-Type': 'application/json', 'X-Requested-With': 'HanchanRecord'},
    data: {name: '拒否される名前'},
  });
  assert.equal(response.status(), 403);
  await outsider.close();
  console.log('管理者権限・対局確認ブラウザテスト: 18項目 OK');
} finally {
  await browser.close();
}
