'use strict';

// Event-delegation checks. Synthetic data only; the browser test talks to the
// in-memory stand-in from scripts/preview-synthetic.cjs on 127.0.0.1.
//   node --test tests/*.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SCRIPT = [...HTML.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(m => !/\bsrc\s*=/.test(m[1])).map(m => m[2]);

test('index.html has exactly one inline application script and it parses', () => {
  assert.equal(SCRIPT.length, 1);
  assert.doesNotThrow(() => new Function(SCRIPT[0]));
});

test('no HTML event attributes remain anywhere in index.html', () => {
  const left = HTML.match(/\son(?:click|change|input|keydown|keyup|blur|focus|submit|drag\w*|drop|mouse\w*)\s*=/gi) || [];
  assert.deepEqual(left, []);
});

test('every uiEvent action used in markup is in the UI_ACTIONS allow-list for that event', () => {
  const used = [...SCRIPT[0].matchAll(/uiEvent\('([a-z]+)','([A-Za-z]+)'/g)].map(m => `${m[1]}:${m[2]}`);
  assert.ok(used.length >= 140, `expected ~145 converted handlers, found ${used.length}`);
  // Build the allow-list objects in isolation (handlers are lazy, so no page globals are needed).
  const block = SCRIPT[0].slice(SCRIPT[0].indexOf('const UI_INPUTS='), SCRIPT[0].indexOf('const UI_PRELOGIN='));
  const { UI_ACTIONS } = require('node:vm').runInNewContext(`${block}; ({UI_ACTIONS})`, { window: {} });
  for (const key of new Set(used)) {
    const [type, action] = key.split(':');
    assert.ok(UI_ACTIONS[type] && Object.hasOwn(UI_ACTIONS[type], action), `${key} missing from UI_ACTIONS.${type}`);
  }
});

test('every generic action calls a window function defined in the script', () => {
  const names = new Set();
  for (const m of SCRIPT[0].matchAll(/uiCalls\(\[([^\]]*)\]\)/g)) {
    for (const n of m[1].matchAll(/'([A-Za-z]+)'/g)) names.add(n[1]);
  }
  assert.ok(names.size > 80);
  for (const n of names) assert.match(SCRIPT[0], new RegExp(`window\\.${n}\\s*=`), `window.${n} is not defined`);
});

test('static HTML only uses the JSON form (manual refresh button)', () => {
  const head = HTML.slice(0, HTML.indexOf('<script>'));
  const attrs = [...head.matchAll(/data-ui-click="([^"]*)"/g)].map(m => JSON.parse(m[1].replace(/&quot;/g, '"')));
  assert.deepEqual(attrs, [{ action: 'manualRefresh', args: [] }]);
});

test('preview refuses to start if a production script host would remain', () => {
  const { preparePreviewHtml } = require('../scripts/preview-synthetic.cjs');
  const page = preparePreviewHtml(HTML);
  assert.match(page, /const SHEET_API_URL="\/__test_api__";/);
  assert.doesNotMatch(page.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/gi, ''), /script\.google/);
  assert.throws(() => preparePreviewHtml(HTML + '<!-- https://script.google.com/macros/s/x/exec -->'), /production script host/);
});

let playwright = null;
try { playwright = require('playwright'); } catch { /* optional */ }

test('browser: synthetic login, editing, drag-and-drop, inbox and logout work through delegation',
  { skip: !playwright && 'playwright not installed (set NODE_PATH to a global install to run)', timeout: 90000 }, async t => {
    const { createServer, HOST } = require('../scripts/preview-synthetic.cjs');
    const { server, api } = createServer();
    await new Promise(r => server.listen(0, HOST, r));
    const base = `http://${HOST}:${server.address().port}/`;
    const browser = await playwright.chromium.launch(
      fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: undefined } : {});
    t.after(async () => { await browser.close(); server.close(); });
    const page = await browser.newPage();
    const problems = [];
    page.on('console', m => { if (['error', 'warning'].includes(m.type())) problems.push(m.text()); });
    page.on('pageerror', e => problems.push(String(e)));
    page.on('request', r => { if (!r.url().startsWith(base)) problems.push('external request: ' + r.url()); });
    await page.goto(base);

    // Before login: clicking a delegated control other than login must do nothing.
    await page.waitForSelector('#logincode');
    const before = api.log.length;
    await page.evaluate(() => {
      const b = document.createElement('button');
      b.setAttribute('data-ui-click', JSON.stringify({ action: 'addProject', args: [] }));
      document.body.appendChild(b); b.click(); b.remove();
    });
    assert.equal(api.log.length, before, 'no API call before login');

    // Wrong password, then Enter-key login.
    await page.fill('#logincode', 'not-a-password');
    await page.click('[data-ui-click*="\\"login\\""]');
    await page.waitForSelector('text=密碼不正確');
    await page.fill('#logincode', 'fake-admin');
    await page.press('#logincode', 'Enter');
    await page.waitForSelector('text=Synthetic Admin');
    await page.waitForSelector('[data-ui-click*="toggleExpand"]');

    // Expand project one and change its status (change + value input).
    const expand = page.locator('[data-ui-click*="toggleExpand"][data-ui-click*="test-project-1"]').first();
    await expand.click();
    const status = page.locator('select[data-ui-change*="\\"status\\""][data-ui-change*="test-project-1"]').first();
    await status.waitFor();
    await status.selectOption('待收款');
    await page.waitForFunction(() => document.getElementById('synchint').textContent.includes('最後同步'));
    await page.waitForTimeout(500);
    assert.equal(api.getState()['test-project-1'].status, '待收款');

    // Switch detail tab (click with two string args), then tick a top-level task (checked input).
    await page.locator('[data-ui-click*="setDetailTab"][data-ui-click*="\\"tasks\\""]').first().click();
    const task = page.locator('input[type=checkbox][data-ui-change*="toggleTask"][data-ui-change*="test-project-1"]').first();
    await task.waitFor();
    await task.click();
    await page.waitForTimeout(800);
    const tasks = api.getState()['test-project-1'].tasks || {};
    assert.ok(Object.values(tasks).some(v => v === true || (v && v.done === true)), 'a task was marked done');

    // Drag the second subtask onto the first row of the same task (dragstart/dragover/drop + stop).
    const rows = page.locator('[data-ui-dragstart*="handleSubtaskDragStart"][data-ui-dragstart*="Synthetic planning"]');
    if (await rows.count() >= 2) {
      await rows.nth(1).dragTo(rows.nth(0));
      await page.waitForTimeout(800);
      const subs = api.getState()['test-project-1'].subtasks['Synthetic planning'].map(s => s.id);
      assert.deepEqual(subs, ['synthetic-sub-3', 'synthetic-sub-1'], 'subtask order changed by drop');
    } else {
      assert.fail('subtask rows were not rendered, drag-and-drop not exercised');
    }

    // Inbox: open the form, type (input event), close it.
    const openInbox = page.locator('[data-ui-click*="openInboxForm"]').first();
    const toggle = page.locator('[data-ui-click*="toggleInbox"]').first();
    assert.ok(await openInbox.count() + await toggle.count() > 0, 'inbox controls rendered');
    if (!(await openInbox.isVisible())) await toggle.click();
    await openInbox.click();
    await page.fill('#inboxtext', 'Synthetic request for Synthetic Owner');
    await page.waitForTimeout(400);
    await page.locator('[data-ui-click*="closeInboxForm"]').first().click();
    assert.equal(await page.locator('#inboxtext').count(), 0, 'inbox form closed');

    // Logout clears the page and stops further actions.
    await page.locator('[data-ui-click*="\\"logout\\""]').first().click();
    await page.waitForSelector('#logincode');
    assert.equal(await page.locator('text=Synthetic Project One').count(), 0, 'project names hidden after logout');
    assert.deepEqual(problems.filter(p => !/Failed to load resource.*404/.test(p)), []);
  });
