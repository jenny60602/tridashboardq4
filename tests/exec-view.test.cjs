'use strict';

// 經營檢視（主管限定）checks. Invented data only; the GAS module is loaded in a sandbox and
// the browser talks to the 127.0.0.1 stand-in from scripts/preview-synthetic.cjs.
//   node --test tests/*.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const GAS = fs.readFileSync(path.join(__dirname, '..', 'gas', 'ExecSummary.gs'), 'utf8');
const { createFixture } = require('./fixtures/dashboard-fixture.cjs');

function gasSandbox({ props = {}, activeId = 'dashboard-sheet', sheets = {} } = {}) {
  const logs = [];
  const ctx = {
    JSON, Math, Number, String, Object, Array, Date, isFinite,
    json_: obj => obj,
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null) }) },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({ getId: () => activeId }),
      openById: id => {
        if (!sheets[id]) throw new Error('no such spreadsheet');
        return { getSheetByName: name => name === '存取紀錄'
          ? { appendRow: row => logs.push(row) }
          : (sheets[id][name] ? { getDataRange: () => ({ getValues: () => JSON.parse(JSON.stringify(sheets[id][name])) }) } : null) };
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(GAS, ctx);
  return { ctx, logs };
}

test('GAS: viewer allow-list fails closed and ignores role level', () => {
  const { ctx } = gasSandbox();
  assert.deepEqual([...ctx.execParseViewers_(null)], []);
  assert.deepEqual([...ctx.execParseViewers_('not json')], []);
  assert.deepEqual([...ctx.execParseViewers_('{"a":1}')], []);
  assert.deepEqual([...ctx.execParseViewers_('[" A ", "A", 3, "", "B"]')], ['A', 'B']);
  const viewers = ['A'];
  assert.equal(ctx.execCanView_({ name: 'A', level: 'none' }, viewers), true);
  assert.equal(ctx.execCanView_({ name: 'B', level: 'admin' }, viewers), false, 'admin outside the list is denied');
  assert.equal(ctx.execCanView_({ name: 'B', level: 'finance' }, viewers), false, 'finance outside the list is denied');
  assert.equal(ctx.execCanView_({ error: 'bad_code' }, viewers), false);
  assert.equal(ctx.execCanView_(null, viewers), false);
  assert.equal(ctx.execCanView_({ name: 'a' }, viewers), false, 'exact match only');
});

test('GAS: rows are validated strictly; bad header rejects the whole sheet', () => {
  const { ctx } = gasSandbox();
  const sheet = createFixture().execSheet;
  const parsed = ctx.execParseRows_(sheet);
  assert.equal(parsed.headerOk, true);
  assert.equal(parsed.rows.length, 6);
  assert.equal(parsed.invalid, 2);
  const ytd = parsed.rows.find(r => r.metric === 'net_income' && r.period === 'ytd' && r.asOfMonth === 9);
  assert.equal(ytd.actual, 500000); assert.equal(ytd.budget, null);
  assert.equal(ytd.updatedAt, '2026-10-02'); assert.equal(ytd.closed, true); assert.equal(ytd.confirmedBy, 'Synthetic Head');
  const comma = ctx.execParseRows_([sheet[0], [2026, 12, 'revenue', '營收', 'annual', '1,234,567.891', '', 'x', 'v', '2026-06-25', '', '否', '<b>']]);
  assert.equal(comma.rows[0].budget, 1234567.89);
  assert.equal(comma.rows[0].note, '＜b＞', 'text is neutralised');
  const badHeader = ctx.execParseRows_([sheet[0].slice().reverse(), sheet[1]]);
  assert.equal(badHeader.headerOk, false); assert.equal(badHeader.rows.length, 0);
  const noAmounts = ctx.execParseRows_([sheet[0], [2026, 9, 'revenue', '營收', 'month', '', '', 'x', 'v', '2026-10-01', '', '否', '']]);
  assert.equal(noAmounts.rows.length, 0); assert.equal(noAmounts.invalid, 1);
  const badClosed = ctx.execParseRows_([sheet[0], [2026, 9, 'revenue', '營收', 'month', '', 1, 'x', 'v', '2026-10-01', '', 'maybe', '']]);
  assert.equal(badClosed.invalid, 1);
});

test('GAS: weekly decision log is validated and returned only through execRead_', () => {
  const f = createFixture();
  const { ctx } = gasSandbox();
  const d = ctx.execParseDecisions_(f.execDecisions);
  assert.equal(d.headerOk, true); assert.equal(d.rows.length, 3); assert.equal(d.invalid, 1);
  assert.equal(d.rows[0].date, '2026-10-20'); assert.equal(d.rows[2].due, '');
  assert.equal(ctx.execParseDecisions_([['x'], ['2026/10/01']]).headerOk, false);
  const badStatus = ctx.execParseDecisions_([f.execDecisions[0], ['2026/10/01', 'T', '', '', '', '', '', '隨便']]);
  assert.equal(badStatus.invalid, 1);
  const props = { EXEC_VIEWERS: '["Head"]', EXEC_SHEET_ID: 'fin' };
  let g = gasSandbox({ props, sheets: { fin: { '財務摘要': f.execSheet, '週會決策紀錄': f.execDecisions } } });
  let r = g.ctx.execRead_({ name: 'Head' });
  assert.equal(r.exec.decisionsStatus, 'ok'); assert.equal(r.exec.decisions.length, 3); assert.equal(r.exec.invalidDecisions, 1);
  g = gasSandbox({ props, sheets: { fin: { '財務摘要': f.execSheet } } });
  r = g.ctx.execRead_({ name: 'Head' });
  assert.equal(r.exec.decisionsStatus, 'missing'); assert.equal(r.exec.decisions.length, 0);
  assert.deepEqual({ ...g.ctx.execRead_({ name: 'Other', level: 'admin' }) }, { ok: false, error: 'forbidden' });
});

test('GAS: execRead_ denies non-viewers, refuses the shared dashboard sheet, logs access', () => {
  const sheet = createFixture().execSheet;
  const props = { EXEC_VIEWERS: '["Head"]', EXEC_SHEET_ID: 'fin-sheet' };
  let { ctx, logs } = gasSandbox({ props, sheets: { 'fin-sheet': { '財務摘要': sheet } } });
  assert.deepEqual({ ...ctx.execRead_({ name: 'Admin', level: 'admin' }) }, { ok: false, error: 'forbidden' });
  const ok = ctx.execRead_({ name: 'Head', level: 'none' });
  assert.equal(ok.ok, true); assert.equal(ok.exec.rows.length, 6);
  assert.deepEqual(JSON.parse(JSON.stringify(logs.map(r => r.slice(1)))), [['Admin', 'execRead', 'denied'], ['Head', 'execRead', 'ok']]);

  ({ ctx } = gasSandbox({ props: { EXEC_VIEWERS: '["Head"]', EXEC_SHEET_ID: 'dashboard-sheet' }, sheets: { 'dashboard-sheet': { '財務摘要': sheet } } }));
  assert.equal(ctx.execRead_({ name: 'Head' }).error, 'exec_not_configured', 'must not read from the shared dashboard spreadsheet');
  ({ ctx } = gasSandbox({ props: { EXEC_VIEWERS: '["Head"]' } }));
  assert.equal(ctx.execRead_({ name: 'Head' }).error, 'exec_not_configured');
  ({ ctx } = gasSandbox({ props: { EXEC_SHEET_ID: 'fin-sheet' }, sheets: { 'fin-sheet': { '財務摘要': sheet } } }));
  assert.equal(ctx.execRead_({ name: 'Head' }).error, 'forbidden', 'no allow-list means nobody');
});

test('repository holds no finance-summary data beyond the blank template', () => {
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'templates', 'finance-summary.template.csv'), 'utf8').trim().split(/\r?\n/);
  assert.equal(tpl.length, 1, 'template is header only');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const script = html.slice(html.indexOf('<script>'));
  const big = (script.match(/\b\d{7,}(\.\d+)?\b/g) || []).filter(n => n !== '86400000'); // ms per day is not money
  assert.deepEqual(big, [], 'no large hard-coded amounts in the page');
  assert.doesNotMatch(html, /\b\d{1,3}(,\d{3})+\.\d{2}\b/, 'no formatted money amounts in the page');
  assert.doesNotMatch(html, /EXEC_VIEWERS\s*=/, 'allow-list is not in the frontend');
});

let playwright = null;
try { playwright = require('playwright'); } catch { /* optional */ }
const skip = !playwright && 'playwright not installed (set NODE_PATH to a global install to run)';
const MARKERS = ['TEST-BUDGET-v1', 'TEST-2026-09', '合成月報', '合成年度預算', 'Synthetic topic A', 'Synthetic question B'];

async function open(t) {
  const { createServer, HOST } = require('../scripts/preview-synthetic.cjs');
  const { server, api } = createServer();
  await new Promise(r => server.listen(0, HOST, r));
  const base = `http://${HOST}:${server.address().port}/`;
  const browser = await playwright.chromium.launch();
  t.after(async () => { await browser.close(); server.close(); });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const problems = [], bodies = [];
  page.on('pageerror', e => problems.push(String(e)));
  page.on('dialog', d => d.accept());
  page.on('response', async r => { if (r.url().includes('__test_api__')) bodies.push(await r.text().catch(() => '')); });
  await page.goto(base);
  return { page, api, problems, bodies };
}
async function login(page, code) {
  await page.waitForSelector('#logincode');
  await page.fill('#logincode', code);
  await page.press('#logincode', 'Enter');
  await page.waitForSelector('[data-ui-click*="toggleExpand"]');
  await page.waitForTimeout(400); // execRead finishes after the first render
}
const domHasMarkers = page => page.evaluate(m => {
  const all = document.documentElement.outerHTML + JSON.stringify(sessionStorage) + JSON.stringify(localStorage);
  return m.filter(x => all.includes(x));
}, MARKERS);

for (const [code, label] of [['fake-admin', 'admin'], ['fake-finance', 'finance'], ['fake-owner', 'owner'], ['fake-member', 'member']]) {
  test(`browser: ${label} cannot see or fetch the executive view`, { skip, timeout: 60000 }, async t => {
    const { page, problems, bodies } = await open(t);
    await login(page, code);
    assert.equal(await page.locator('#exectab').isHidden(), true, 'tab hidden');
    // Forcing the tab visible in the browser still yields nothing, because the server refuses.
    await page.evaluate(() => { document.getElementById('exectab').hidden = false; });
    await page.locator('#exectab').click();
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => view), 'project', 'view did not switch');
    const direct = await page.evaluate(async () => apiPost({ action: 'execRead', token: authToken }));
    assert.deepEqual(direct, { ok: false, error: 'forbidden' });
    assert.deepEqual(await domHasMarkers(page), []);
    assert.deepEqual(bodies.filter(b => MARKERS.some(m => b.includes(m))), [], 'no response carried finance-summary data');
    assert.deepEqual(problems, []);
  });
}

test('browser: an allowed viewer sees the annual targets; nothing is inferred', { skip, timeout: 60000 }, async t => {
  const { page, problems, bodies } = await open(t);
  await login(page, 'fake-ops');
  await page.waitForSelector('#exectab:not([hidden])');
  await page.locator('#exectab').click();
  await page.waitForSelector('.execgrid');
  const text = await page.locator('#view').innerText();
  assert.match(text, /年度營業收入預算\s*12,000,000\.5\s*預算版本/);
  assert.match(text, /年度稅後淨利目標\s*800,000\.25\s*預算版本/);
  assert.match(text, /實際營收（年初至今）\s*尚未連結資料\s*尚未取得/, 'missing YTD revenue is not inferred');
  assert.match(text, /實際稅後淨利（年初至今）\s*500,000\s*已確認數據/);   // month 9 row, not the older month 8 row
  assert.match(text, /達成率\s*62\.5%\s*管理分析/);                          // 500000 / 800000.25
  assert.match(text, /剩餘目標差額\s*300,000\.25/);
  assert.match(text, /9 月營收\s*1,500,000\s*未確認數據/);
  assert.match(text, /9 月稅後淨利\s*300,000\s*未確認數據/);
  assert.match(text, /資料截至 2026\/09\/30/);
  assert.match(text, /2 項實際數字尚未結帳或未填確認人/);
  assert.match(text, /2 列格式不符/);
  assert.match(text, /沒有 P0／P1／P2 優先級欄位/);
  // Sections C/D: this viewer is not on the scorecard list, so no scores are shown; business lines still are.
  assert.match(text, /提案中、尚未決定的新機會\s*0 案\s*你不在評分名單內/);
  assert.match(text, /C\. 新機會評估[\s\S]*不在機會評估名單內/);
  assert.match(text, /D\. 業務線[\s\S]*企業與通路/);
  assert.doesNotMatch(text, /部門＼業務|週會決策紀錄|Synthetic topic/, 'old sections C–E removed');
  // Finance-summary data only ever arrives in the execRead reply.
  const carriers = bodies.filter(b => MARKERS.some(m => b.includes(m)));
  assert.ok(carriers.length >= 1 && carriers.every(b => b.includes('"exec"')));
  assert.equal(await page.evaluate(() => JSON.stringify(state).includes('TEST-BUDGET')), false, 'not in shared state');

  // Budget only (no actual P&L imported yet): every actual figure says 尚未連結資料.
  await page.evaluate(() => { EXEC.rows = EXEC.rows.filter(r => r.period === 'annual'); render(); });
  const budgetOnly = await page.locator('#view .priority').first().innerText(); // section A only
  for (const label of ['實際營收（年初至今）', '實際稅後淨利（年初至今）', '年度淨利目標達成率', '剩餘目標差額', '當月營收', '當月稅後淨利']) {
    assert.match(budgetOnly, new RegExp(label + '\\s*尚未連結資料'), label);
  }
  assert.doesNotMatch(budgetOnly, /\d+(\.\d+)?%/, 'no rate without actual data');
  assert.deepEqual(problems, []);
});

test('browser: logout and session expiry clear the executive view at once', { skip, timeout: 60000 }, async t => {
  const { page, api, problems } = await open(t);
  await login(page, 'fake-head');
  await page.locator('#exectab').click();
  await page.waitForSelector('.execgrid');
  await page.locator('[data-ui-click*="\\"logout\\""]').first().click();
  await page.waitForSelector('#logincode');
  assert.equal(await page.locator('#exectab').isHidden(), true);
  assert.equal(await page.evaluate(() => EXEC), null);
  assert.deepEqual(await domHasMarkers(page), []);

  await login(page, 'fake-head');
  await page.locator('#exectab').click();
  await page.waitForSelector('.execgrid');
  api.expire();
  await page.evaluate(() => window.manualRefresh());
  await page.waitForSelector('text=登入已過期');
  assert.equal(await page.evaluate(() => EXEC), null);
  assert.deepEqual(await domHasMarkers(page), []);
  // Another person on the same tab never inherits it.
  await login(page, 'fake-finance');
  assert.equal(await page.locator('#exectab').isHidden(), true);
  assert.deepEqual(await domHasMarkers(page), []);
  assert.deepEqual(problems, []);
});

test('browser: the Excel export of an allowed viewer does not include the finance summary', { skip, timeout: 60000 }, async t => {
  const { page, problems } = await open(t);
  await login(page, 'fake-head');
  await page.locator('#exectab').click();
  await page.waitForSelector('.execgrid');
  await page.locator('.tabs button[data-v="project"]').click();
  const exportBtn = page.locator('[data-ui-click*="exportMonthlyExcel"]').first();
  if (!(await exportBtn.count())) { t.diagnostic('export not offered to this role'); return; }
  const [download] = await Promise.all([page.waitForEvent('download'), exportBtn.click()]);
  const XLSX = require('../vendor/xlsx.full.min.js');
  const wb = XLSX.read(fs.readFileSync(await download.path()));
  const dump = wb.SheetNames.map(n => JSON.stringify(XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1 }))).join('\n');
  for (const m of MARKERS) assert.ok(!dump.includes(m), `export contains ${m}`);
  assert.ok(!/800000\.25|12000000\.5/.test(dump), 'no summary amounts in export');
  assert.deepEqual(problems, []);
});

test('browser: executive view fits a phone screen without sideways scrolling', { skip, timeout: 60000 }, async t => {
  const { page, problems } = await open(t);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'fake-ops');
  await page.locator('#exectab').click();
  await page.waitForSelector('.execgrid');
  const w = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  assert.ok(w[0] <= w[1], `page width ${w[0]} exceeds viewport ${w[1]}`);
  assert.deepEqual(problems, []);
});
