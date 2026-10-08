'use strict';

// Draft recovery, request timeouts and late responses. Synthetic data only; the page
// talks to the in-memory stand-in from scripts/preview-synthetic.cjs on 127.0.0.1.
//   node --test tests/*.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');

let playwright = null;
try { playwright = require('playwright'); } catch { /* optional */ }
const skip = !playwright && 'playwright not installed (set NODE_PATH to a global install to run)';
const API = '**/__test_api__*';

async function setup(t) {
  const { createServer, HOST } = require('../scripts/preview-synthetic.cjs');
  const { server, api } = createServer();
  await new Promise(r => server.listen(0, HOST, r));
  const base = `http://${HOST}:${server.address().port}/`;
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage();
  const problems = [];
  page.on('pageerror', e => problems.push(String(e)));
  page.on('request', r => { if (!r.url().startsWith(base)) problems.push('external request: ' + r.url()); });
  page.on('dialog', d => d.accept());
  t.after(async () => { await browser.close(); server.close(); });
  await page.goto(base);
  return { page, api, base, problems };
}

async function login(page, code = 'fake-admin') {
  await page.waitForSelector('#logincode');
  await page.fill('#logincode', code);
  await page.press('#logincode', 'Enter');
  await page.waitForSelector('[data-ui-click*="toggleExpand"]');
}

async function setStatus(page, value) {
  const status = page.locator('select[data-ui-change*="\\"status\\""][data-ui-change*="test-project-1"]').first();
  if (!(await status.count())) {
    await page.locator('[data-ui-click*="toggleExpand"][data-ui-click*="test-project-1"]').first().click();
  }
  await status.waitFor();
  await status.selectOption(value);
}

const draft = page => page.evaluate(() => JSON.parse(sessionStorage.getItem('dash_draft_v4') || 'null'));
const bannerText = page => page.locator('#restorebanner').innerText();

test('unsent edit survives a reload and can be restored after re-verification', { skip, timeout: 90000 }, async t => {
  const { page, api, problems } = await setup(t);
  await login(page);
  // Network down before the write is dispatched (the capability ping fails).
  await page.route(API, route => route.request().method() === 'GET' ? route.abort() : route.continue());
  await setStatus(page, '待收款');
  await page.waitForFunction(() => document.getElementById('synchint').textContent.includes('尚未確認同步完成'));
  assert.notEqual(api.getState()['test-project-1'].status, '待收款', 'server unchanged');
  const saved = await draft(page);
  assert.equal(saved.state['test-project-1'].status, '待收款');
  assert.equal(saved.uncertain, false);

  await page.unroute(API);
  await page.reload();
  await page.waitForSelector('#restorebanner h3');
  assert.match(await bannerText(page), /尚未同步的草稿/);
  assert.equal(await page.evaluate(() => document.getElementById('dashboardcontent').inert), true, 'editing paused');
  // While pending, edits are ignored by the dispatcher.
  const before = api.log.length;
  await page.evaluate(() => {
    const b = document.createElement('button');
    b.setAttribute('data-ui-click', JSON.stringify({ action: 'addProject', args: [] }));
    document.body.appendChild(b); b.click(); b.remove();
  });
  assert.equal(api.log.length, before);

  await page.locator('[data-ui-click*="restoreBackup"][data-ui-click*="theirs"]').click();
  await page.waitForFunction(() => !document.getElementById('restorebanner').textContent.trim());
  await page.waitForFunction(() => document.getElementById('synchint').textContent.includes('自動同步中'));
  assert.equal(api.getState()['test-project-1'].status, '待收款', 'restored edit reached the server');
  assert.equal(await draft(page), null, 'draft cleared after confirmed sync');
  assert.deepEqual(problems, [], JSON.stringify(problems));
});

test('a write whose reply is lost is not resent automatically and reconciles once confirmed', { skip, timeout: 90000 }, async t => {
  const { page, api, problems } = await setup(t);
  await login(page);
  // The server applies the write, but the browser never sees the reply.
  await page.route(API, async route => {
    const req = route.request();
    if (req.method() === 'POST' && JSON.parse(req.postData() || '{}').action === 'write') {
      await route.fetch(); return route.abort();
    }
    return route.continue();
  });
  await setStatus(page, '已完成');
  await page.waitForSelector('#restorebanner h3');
  assert.match(await bannerText(page), /尚未確認/);
  assert.equal(api.getState()['test-project-1'].status, '已完成', 'server did store it');
  const writes = () => api.log.filter(a => a === 'write').length;
  const n = writes();
  await page.waitForTimeout(1500);
  assert.equal(writes(), n, 'no automatic resend while uncertain');
  assert.equal((await draft(page)).uncertain, true);

  await page.unroute(API);
  await page.locator('[data-ui-click*="restoreBackup"][data-ui-click*="theirs"]').click();
  await page.waitForFunction(() => !document.getElementById('restorebanner').textContent.trim());
  await page.waitForFunction(() => document.getElementById('synchint').textContent.includes('自動同步中'));
  assert.equal(api.getState()['test-project-1'].status, '已完成');
  assert.equal(await draft(page), null);
  assert.deepEqual(problems, [], JSON.stringify(problems));
});

test('logout with unsynced edits asks, then clears the draft and the page', { skip, timeout: 90000 }, async t => {
  const { page, problems } = await setup(t);
  await login(page);
  await page.route(API, route => route.request().method() === 'GET' ? route.abort() : route.continue());
  await setStatus(page, '待收款');
  await page.waitForFunction(() => !!sessionStorage.getItem('dash_draft_v4'));
  let asked = false;
  page.removeAllListeners('dialog');
  page.on('dialog', d => { asked = /未同步/.test(d.message()); d.accept(); });
  await page.locator('[data-ui-click*="\\"logout\\""]').first().click();
  await page.waitForSelector('#logincode');
  assert.ok(asked, 'confirmation shown');
  assert.equal(await draft(page), null);
  assert.equal(await page.locator('text=Synthetic Project One').count(), 0);
  assert.deepEqual(problems, [], JSON.stringify(problems));
});

test('a read that arrives after logout does not bring the data back', { skip, timeout: 90000 }, async t => {
  const { page, problems } = await setup(t);
  await login(page);
  let release;
  const gate = new Promise(r => { release = r; });
  await page.route(API, async route => {
    const req = route.request();
    if (req.method() === 'POST' && JSON.parse(req.postData() || '{}').action === 'read') {
      const res = await route.fetch(); await gate; return route.fulfill({ response: res });
    }
    return route.continue();
  });
  const pending = page.evaluate(() => window.manualRefresh());
  await page.waitForTimeout(500);
  await page.locator('[data-ui-click*="\\"logout\\""]').first().click();
  await page.waitForSelector('#logincode');
  release();
  await pending.catch(() => {});
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => document.body.classList.contains('locked')), true, 'still locked');
  assert.equal(await page.locator('#logincode').count(), 1);
  assert.equal(await page.locator('text=Synthetic Project One').count(), 0);
  assert.deepEqual(problems, [], JSON.stringify(problems));
});

test('an expired session keeps the draft for the same person; another person never sees it', { skip, timeout: 90000 }, async t => {
  const { page, api, problems } = await setup(t);
  await login(page, 'fake-owner');
  api.expire();
  await setStatus(page, '待收款');
  await page.waitForSelector('text=登入已過期');
  const kept = await draft(page);
  assert.equal(kept.owner, 'Synthetic Owner');
  assert.equal(kept.state['test-project-1'].status, '待收款');

  // A different person logs in on this tab: the draft is discarded, not offered.
  await login(page, 'fake-member');
  await page.waitForTimeout(500);
  assert.equal(await page.locator('#restorebanner h3').count(), 0);
  assert.equal(await draft(page), null);
  assert.deepEqual(problems, [], JSON.stringify(problems));
});

test('the same person re-logging in after expiry is offered the draft', { skip, timeout: 90000 }, async t => {
  const { page, api, problems } = await setup(t);
  await login(page, 'fake-owner');
  api.expire();
  await setStatus(page, '待收款');
  await page.waitForSelector('text=登入已過期');
  await login(page, 'fake-owner');
  await page.waitForSelector('#restorebanner h3');
  await page.locator('[data-ui-click*="restoreBackup"][data-ui-click*="mine"]').click();
  await page.waitForFunction(() => !document.getElementById('restorebanner').textContent.trim());
  await page.waitForTimeout(500);
  assert.equal(api.getState()['test-project-1'].status, '待收款');
  assert.deepEqual(problems, [], JSON.stringify(problems));
});

test('a request that never answers is abandoned after the timeout and frees the save queue', { skip, timeout: 90000 }, async t => {
  const { page, problems } = await setup(t);
  await login(page);
  // Shorten the 30 s limit for the test only.
  const limit = await page.evaluate(() => REQUEST_TIMEOUT_MS);
  assert.equal(limit, 30000);
  await page.route(API, route => (route.request().method() === 'GET' ? new Promise(() => {}) : route.continue()));
  const started = Date.now();
  const outcome = await page.evaluate(async () => {
    try { await requestJson(SHEET_API_URL + '?ping=1', { cache: 'no-store' }); return 'resolved'; }
    catch (e) { return e.message; }
  });
  assert.equal(outcome, 'request_timeout');
  assert.ok(Date.now() - started >= 29000, 'waited for the full limit');
  assert.deepEqual(problems, [], JSON.stringify(problems));
});

test('polling with no edits never sends a write and the hint says in sync', { skip, timeout: 90000 }, async t => {
  const { page, api, problems } = await setup(t);
  await login(page);
  const writes = () => api.log.filter(a => a === 'write').length;
  const before = writes();
  for (let i = 0; i < 3; i++) await page.evaluate(() => window.manualRefresh());
  await page.waitForTimeout(800);
  assert.equal(writes(), before, 'no write without a real edit');
  assert.match(await page.locator('#synchint').innerText(), /自動同步中/);
  // A real edit is still written exactly once, and polling afterwards stays quiet.
  await setStatus(page, '待收款');
  await page.waitForFunction(() => document.getElementById('synchint').textContent.includes('自動同步中'));
  const afterEdit = writes();
  assert.equal(afterEdit, before + 1, 'one write for one edit');
  for (let i = 0; i < 2; i++) await page.evaluate(() => window.manualRefresh());
  await page.waitForTimeout(800);
  assert.equal(writes(), afterEdit, 'no extra writes after the edit synced');
  assert.deepEqual(problems, [], JSON.stringify(problems));
});
