'use strict';

// 財務預估區「本月」營收預估明細：業務線加總、完成%、缺口、沒有目標、提案中排除、權限畫面。Synthetic data only.
//   node --test tests/*.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');

let playwright = null;
try { playwright = require('playwright'); } catch { /* optional */ }
const skip = !playwright && 'playwright not installed (set NODE_PATH to a global install to run)';

async function start(t) {
  const { createServer, HOST } = require('../scripts/preview-synthetic.cjs');
  const { server } = createServer();
  await new Promise(r => server.listen(0, HOST, r));
  const base = `http://${HOST}:${server.address().port}/`;
  const browser = await playwright.chromium.launch();
  t.after(async () => { await browser.close(); server.close(); });
  const login = async (code, width = 1280) => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const problems = [];
    page.on('pageerror', e => problems.push(String(e)));
    await page.goto(base);
    await page.fill('#logincode', code);
    await page.press('#logincode', 'Enter');
    await page.waitForSelector('[data-ui-click*="toggleExpand"]');
    return { page, problems };
  };
  return { login };
}

// Invented scenario: one project per business line, a proposal with an issued invoice and an estimate.
const SCENARIO = () => {
  const set = (id, patch) => { state[id] = Object.assign({}, getRow(id), patch); };
  set('test-project-1', { bizLine: '2B 專案' });                       // 11 月：預估 6,000（10 月的發票不算 11 月）
  set('test-project-2', { bizLine: '2C 零售' });                       // 11 月：預估 4,000
  set('test-opportunity', { bizLine: '2B 禮盒', status: '提案中',       // 11 月：只算已開發票 2,000，預估 3,000 不算
    invoices: [{ date: '2026-11-05', no: 'SYNTHETIC-OPP', amount: 2000, dueDate: '', paid: false, paidDate: '' }],
    estPlan: [{ month: 11, amount: 2000 }, { month: 11, amount: 3000 }] });   // 第 1 筆預估已由發票取代
};
const TARGETS = { lines: { '2C 零售': 5000, '2B 禮盒': 1000, '2B 專案': 6000, '2G 政府／補助': 2000 }, subtotal: 14000, total: 15000 };
const pickRows = rows => rows.map(r => [r.label, r.count, r.actual, r.est, r.total, r.target, r.pct, r.gap]);

test('calc: business-line sums, subtotal/total, completion %, gap, proposals and missing targets', { skip, timeout: 60000 }, async t => {
  const { login } = await start(t);
  const { page, problems } = await login('fake-admin');
  const res = await page.evaluate(({ src, targets }) => {
    eval(src)();
    const ps = FINP();
    const withT = monthLineRows(11, ps, targets);
    const noT = monthLineRows(11, ps, null);
    state['test-opportunity'] = Object.assign({}, getRow('test-opportunity'), { status: '未成案' });
    const lost = monthLineRows(11, ps, targets).find(r => r.label === '2B 禮盒');
    state['test-opportunity'] = Object.assign({}, getRow('test-opportunity'), { status: '進行中' });
    const active = monthLineRows(11, ps, targets).find(r => r.label === '2B 禮盒');
    state['test-project-2'] = Object.assign({}, getRow('test-project-2'), { bizLine: null });
    const pending = monthLineRows(11, ps, targets);
    return { withT, noT, lost, active, pending };
  }, { src: `(${SCENARIO})`, targets: TARGETS });

  assert.deepEqual(pickRows(res.withT), [
    ['2C 零售', 1, 0, 4000, 4000, 5000, 80, 1000],
    ['2B 禮盒', 1, 2000, 0, 2000, 1000, 200, -1000],
    ['2B 專案', 1, 0, 6000, 6000, 6000, 100, 0],
    ['2G 政府／補助', 0, 0, 0, 0, 2000, 0, 2000],
    ['小計', 3, 2000, 10000, 12000, 14000, 86, 2000],
    ['合計', 3, 2000, 10000, 12000, 15000, 80, 3000],
  ]);
  // No targets: amounts unchanged, target / % / gap stay empty (rendered as 尚未連結資料).
  assert.deepEqual(res.noT.map(r => [r.label, r.total, r.target, r.pct, r.gap]),
    res.withT.map(r => [r.label, r.total, null, null, null]));
  // 未成案 behaves like 提案中 (issued only); an active project also counts its estimate.
  assert.deepEqual([res.lost.actual, res.lost.est], [2000, 0]);
  assert.deepEqual([res.active.actual, res.active.est], [2000, 3000]);
  // Unclassified projects get their own row, outside 小計 but inside 合計, with no target.
  const byLabel = Object.fromEntries(res.pending.map(r => [r.label, r]));
  assert.deepEqual(res.pending.map(r => r.label), ['2C 零售', '2B 禮盒', '2B 專案', '2G 政府／補助', '小計', '待分類', '合計']);
  assert.equal(byLabel['待分類'].total, 4000);
  assert.equal(byLabel['待分類'].target, null);
  // At this point the former proposal is active (2,000 issued + 3,000 estimate) and project 2 is unclassified.
  assert.equal(byLabel['小計'].total, 5000 + 6000, 'subtotal excludes 待分類');
  assert.equal(byLabel['合計'].total, 5000 + 6000 + 4000);
  assert.deepEqual(problems, []);
});

test('calc: targets come only from the finance summary, per fiscal month, and only for full-view exec viewers', { skip, timeout: 60000 }, async t => {
  const { login } = await start(t);
  const head = await login('fake-head');
  await head.page.waitForFunction(() => typeof EXEC !== 'undefined' && EXEC && EXEC.rows.length > 0);
  const exec = await head.page.evaluate(() => EXEC);
  const { page, problems } = await login('fake-admin');
  const r = await page.evaluate(e => {
    const before = monthLineTargets(11);
    execAllowed = true; EXEC = e;
    const nov = monthLineTargets(11), jan = monthLineTargets(1);
    const realIsFinAll = isFinAll; isFinAll = () => false;
    const partial = monthLineTargets(11); isFinAll = realIsFinAll;
    return { before, nov, jan, partial,
      defaults: ['2026-11-16', '2026-07-01', '2027-02-10', '2027-05-01'].map(d => finDefaultMonth(new Date(d + 'T12:00:00'))) };
  }, exec);
  assert.equal(r.before, null, 'no finance-summary access → no targets');
  assert.deepEqual(r.nov, { lines: { '2C 零售': 400000, '2B 禮盒': null, '2B 專案': 600000, '2G 政府／補助': null }, subtotal: null, total: 1000000 });
  assert.equal(r.jan, null, '2027 months have no 2026 budget');
  assert.equal(r.partial, null, 'someone who sees only some projects is not compared with company targets');
  assert.deepEqual(r.defaults, [11, 9, 2, 3]);
  assert.deepEqual(problems, []);
});

test('browser: month view with and without target access, month switch, phone width', { skip, timeout: 90000 }, async t => {
  const { login } = await start(t);
  const head = await login('fake-head');
  await head.page.waitForFunction(() => typeof EXEC !== 'undefined' && EXEC && EXEC.rows.length > 0);
  const exec = await head.page.evaluate(() => EXEC);

  const { page, problems } = await login('fake-admin');
  await page.evaluate(src => { eval(src)(); finMonth = 11; renderPriority(); }, `(${SCENARIO})`);
  await page.locator('[data-ui-click*="setFinView"]').click();
  await page.waitForSelector('table.monthlines');
  const cards = page.locator('.fincards.five .fincard');
  assert.equal(await cards.count(), 5);
  const cardText = await page.locator('.fincards.five').innerText();
  assert.match(cardText, /11月 預估營收\s*1\.2\s*萬元/);
  assert.equal((cardText.match(/尚未連結資料/g) || []).length, 3, 'target, %, gap need data access');
  assert.match(cardText, /可回補\s*待定義/);
  const rowText = label => page.evaluate(l => { const tr = [...document.querySelectorAll('table.monthlines tbody tr')].find(x => x.cells[0].textContent.trim() === l);
    return tr ? tr.innerText.replace(/\s+/g, ' ').trim() : null; }, label);
  assert.equal(await rowText('2B 禮盒'), '2B 禮盒 1 0.2 0 0.2 尚未連結資料 尚未連結資料 尚未連結資料');
  assert.match(await rowText('合計'), /^合計 3 0\.2 1 1\.2 尚未連結資料/);
  assert.match(await page.locator('.priority').first().innerText(), /提案中、未成案只計入已開發票的部分/);

  // With finance-summary access (synthetic budget: 2C 40 萬, 2B 專案 60 萬, company 100 萬).
  await page.evaluate(e => { execAllowed = true; EXEC = e; renderPriority(); }, exec);
  assert.match(await rowText('2C 零售'), /^2C 零售 1 0 0\.4 0\.4 40 1% 39\.6$/);
  assert.match(await rowText('2B 禮盒'), /尚未連結資料/, 'a line without a budget row');
  assert.match(await rowText('合計'), /^合計 3 0\.2 1 1\.2 100 1% 98\.8$/);
  const pctColor = await page.locator('table.monthlines tr.total td').nth(6).locator('b').getAttribute('style');
  assert.match(pctColor, /var\(--warn\)/, 'below target in red');
  // Reaching the target turns green.
  await page.evaluate(() => { const rows = monthLineRows(11, FINP(), { lines: { '2C 零售': 1, '2B 禮盒': 1, '2B 專案': 1, '2G 政府／補助': 0 }, subtotal: 3, total: 3 }); window.__ok = pctHtml(rows[rows.length - 1]) + gapHtml(rows[rows.length - 1]); });
  assert.match(await page.evaluate(() => window.__ok), /var\(--ok\)[\s\S]*已達標/);

  // Month switch.
  await page.selectOption('select.finmonth', '10');
  assert.equal(await page.evaluate(() => finSelMonth()), 10);
  assert.match(await page.locator('.fincards.five').innerText(), /10月 預估營收\s*0\.6\s*萬元/);
  await page.evaluate(() => setFinMonth('99'));
  assert.equal(await page.evaluate(() => finMonth), null, 'invalid month falls back to the default');

  // Other modes still work and hide the month view.
  await page.locator('[data-ui-click*="setFinMode"][data-ui-click*="cash"]').click();
  assert.equal(await page.locator('table.monthlines').count(), 0);
  assert.match(await page.locator('.fincards').first().innerText(), /2026 Q4 現金流入/);

  const mobile = await login('fake-admin', 390);
  await mobile.page.locator('[data-ui-click*="setFinView"]').click();
  await mobile.page.waitForSelector('table.monthlines');
  assert.ok(await mobile.page.evaluate(() => document.documentElement.scrollWidth <= 390), 'table scrolls inside its box, not the page');
  assert.deepEqual([...problems, ...head.problems, ...mobile.problems], []);
});
