'use strict';

// 財務預估區「本月」營收預估明細：核心（依業務線）／關係人／營業外分段、營收合計、完成%、缺口、
// 沒有目標、提案中排除、補助與政府的分類、毛利參考、權限畫面。Synthetic data only.
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
  const execFromHead = async () => {
    const head = await login('fake-head');
    await head.page.waitForFunction(() => typeof EXEC !== 'undefined' && EXEC && EXEC.rows.length > 0);
    return { exec: await head.page.evaluate(() => EXEC), problems: head.problems };
  };
  return { login, execFromHead };
}

// Invented scenario for 11 月:
//   project-1 → 2B 專案，預估 6,000（10 月的發票不算 11 月），已登錄支出 11 月 1,500
//   project-2 → 2C 零售，預估 4,000，沒有支出
//   opportunity → 2B 禮盒，提案中：只算已開發票 2,000（第 2 筆預估 3,000 不算）
const SCENARIO = () => {
  const set = (id, patch) => { state[id] = Object.assign({}, getRow(id), patch); };
  set('test-project-1', { bizLine: '2B 專案', expenses: [{ id: 'syn-exp-1', month: 11, amount: 1500, item: 'Synthetic cost', payDate: '', paid: false, paidDate: '' }] });
  set('test-project-2', { bizLine: '2C 零售' });
  set('test-opportunity', { bizLine: '2B 禮盒', status: '提案中',
    invoices: [{ date: '2026-11-05', no: 'SYNTHETIC-OPP', amount: 2000, dueDate: '', paid: false, paidDate: '' }],
    estPlan: [{ month: 11, amount: 2000 }, { month: 11, amount: 3000 }] });   // 第 1 筆預估已由發票取代
};
const TARGETS = { lines: { '2C 零售': 5000, '2B 禮盒': 1000, '2B 專案': 6000, '2G 政府／補助': 2000 }, core: 14000, total: 15000, nonop: 1000, gm: 0.3 };
const pick = rows => rows.map(r => [r.label, r.count, r.actual, r.est, r.total, r.target, r.pct, r.gap]);

test('calc: core lines, related party, total, non-operating, completion %, gap, proposals, missing targets', { skip, timeout: 60000 }, async t => {
  const { login } = await start(t);
  const { page, problems } = await login('fake-admin');
  const res = await page.evaluate(({ src, targets }) => {
    eval(src)();
    const ps = FINP(), rows = () => monthLineRows(11, ps, targets);
    const set = (id, patch) => { state[id] = Object.assign({}, getRow(id), patch); };
    const base = rows(), noT = monthLineRows(11, ps, null);
    set('test-opportunity', { status: '未成案' }); const lost = rows().find(r => r.key === '2B 禮盒');
    set('test-opportunity', { status: '進行中' }); const active = rows().find(r => r.key === '2B 禮盒');
    set('test-project-2', { relatedParty: true }); const relRows = rows();
    set('test-project-2', { relatedParty: false, bizLine: null }); state['test-project-2'].catOverride = '補助'; refreshAll();
    const nonopRows = monthLineRows(11, FINP(), targets);
    state['test-project-2'].catOverride = '政府'; refreshAll();
    const govRows = monthLineRows(11, FINP(), targets);
    state['test-project-2'].catOverride = null; set('test-project-2', { bizLine: null }); refreshAll();
    const pendRows = monthLineRows(11, FINP(), targets);
    return { base, noT, lost, active, relRows, nonopRows, govRows, pendRows };
  }, { src: `(${SCENARIO})`, targets: TARGETS });

  assert.deepEqual(pick(res.base), [
    ['2C 零售', 1, 0, 4000, 4000, 5000, 80, 1000],
    ['2B 禮盒', 1, 2000, 0, 2000, 1000, 200, -1000],
    ['2B 專案', 1, 0, 6000, 6000, 6000, 100, 0],
    ['2G 政府（標案／委託）', 0, 0, 0, 0, 2000, 0, 2000],
    ['核心營收小計', 3, 2000, 10000, 12000, 14000, 86, 2000],
    ['關係人交易小計', 0, 0, 0, 0, null, null, null],
    ['營收合計', 3, 2000, 10000, 12000, 15000, 80, 3000],
    ['營業外收入小計（補助）', 0, 0, 0, 0, 1000, 0, 1000],
  ]);
  // No targets: amounts unchanged; target / % / gap stay empty (rendered as 尚未連結資料).
  assert.deepEqual(res.noT.map(r => [r.label, r.total, r.target, r.pct, r.gap]), res.base.map(r => [r.label, r.total, null, null, null]));
  // 未成案 behaves like 提案中 (issued only); an active project also counts its estimate.
  assert.deepEqual([res.lost.actual, res.lost.est], [2000, 0]);
  assert.deepEqual([res.active.actual, res.active.est], [2000, 3000]);
  const by = rows => Object.fromEntries(rows.map(r => [r.key, r]));
  // Related party leaves its business line, counts in 關係人 and in 營收合計.
  const rel = by(res.relRows);
  assert.deepEqual([rel['2C 零售'].total, rel.rel.total, rel.core.total, rel.total.total], [0, 4000, 11000, 15000]);
  // 補助 category → 營業外: outside 營收合計, compared with the non-operating budget.
  const non = by(res.nonopRows);
  assert.deepEqual([non.nonop.total, non.nonop.pct, non.total.total, non['2G 政府／補助'].total], [4000, 400, 11000, 0]);
  // 政府 category (標案／委託) → core revenue on the 2G line.
  const gov = by(res.govRows);
  assert.deepEqual([gov['2G 政府／補助'].total, gov.nonop.total, gov.total.total], [4000, 0, 15000]);
  // Unclassified core project: own row inside 核心營收小計, no target of its own.
  assert.deepEqual(res.pendRows.map(r => r.key), ['2C 零售', '2B 禮盒', '2B 專案', '2G 政府／補助', '待分類', 'core', 'rel', 'total', 'nonop']);
  const pend = by(res.pendRows);
  assert.deepEqual([pend['待分類'].total, pend['待分類'].target, pend.core.total, pend.core.target], [4000, null, 15000, 14000]);
  assert.deepEqual(problems, []);
});

test('calc: margin reference, targets by fiscal month, partial view, default month', { skip, timeout: 60000 }, async t => {
  const { login, execFromHead } = await start(t);
  const { exec, problems: hp } = await execFromHead();
  const { page, problems } = await login('fake-admin');
  const r = await page.evaluate(({ src, e, targets }) => {
    eval(src)();
    const margin = monthMarginInfo(11, FINP(), targets), marginNoT = monthMarginInfo(11, FINP(), null), empty = monthMarginInfo(3, FINP(), targets);
    const before = monthLineTargets(11);
    execAllowed = true; EXEC = e;
    const nov = monthLineTargets(11), jan = monthLineTargets(1);
    const realIsFinAll = isFinAll; isFinAll = () => false;
    const partial = monthLineTargets(11); isFinAll = realIsFinAll;
    return { margin, marginNoT, empty, before, nov, jan, partial,
      defaults: ['2026-11-16', '2026-07-01', '2027-02-10', '2027-05-01'].map(d => finDefaultMonth(new Date(d + 'T12:00:00'))) };
  }, { src: `(${SCENARIO})`, e: exec, targets: TARGETS });
  // Revenue 12,000 (core + related), cost 1,500 → 87.5%; 1 of 3 projects has expenses.
  assert.deepEqual(r.margin, { rev: 12000, cost: 1500, gm: 0.875, withExp: 1, n: 3, budgetGm: 0.3 });
  assert.equal(r.marginNoT.budgetGm, null);
  assert.equal(r.empty.n, 0);
  assert.equal(r.before, null, 'no finance-summary access → no targets');
  assert.deepEqual(r.nov.lines, { '2C 零售': 400000, '2B 禮盒': null, '2B 專案': 600000, '2G 政府／補助': null });
  assert.equal(r.nov.core, null, 'core target needs all four lines');
  assert.equal(r.nov.total, 1000000);
  assert.equal(r.nov.nonop, 50000);
  assert.equal(r.jan, null, '2027 months have no 2026 budget');
  assert.equal(r.partial, null, 'someone who sees only some projects is not compared with company targets');
  assert.deepEqual(r.defaults, [11, 9, 2, 3]);
  assert.deepEqual([...problems, ...hp], []);
});

test('browser: month view is first and default, with and without target access, month switch, phone width', { skip, timeout: 90000 }, async t => {
  const { login, execFromHead } = await start(t);
  const { exec, problems: hp } = await execFromHead();
  const { page, problems } = await login('fake-admin');
  await page.evaluate(src => { eval(src)(); finMonth = 11; renderPriority(); }, `(${SCENARIO})`);
  await page.waitForSelector('table.monthlines');
  const segs = await page.locator('.priority .seg button').allInnerTexts();
  assert.deepEqual(segs, ['本月', '營收與毛利', '現金流']);
  assert.match(await page.locator('.priority .seg button.active').innerText(), /本月/);

  const cards = await page.locator('.fincards.five').innerText();
  assert.equal(await page.locator('.fincards.five .fincard').count(), 5);
  assert.match(cards, /11月 預估營收\s*1\.2\s*萬元/);
  assert.equal((cards.match(/尚未連結資料/g) || []).length, 3, 'target, %, gap need data access');
  assert.match(cards, /可回補\s*待定義/);
  const rowText = label => page.evaluate(l => { const tr = [...document.querySelectorAll('table.monthlines tbody tr')].find(x => x.cells[0].textContent.trim() === l);
    return tr ? tr.innerText.replace(/\s+/g, ' ').trim() : null; }, label);
  assert.equal(await rowText('2B 禮盒'), '2B 禮盒 1 0.2 0 0.2 尚未連結資料 尚未連結資料 尚未連結資料');
  assert.match(await rowText('營收合計'), /^營收合計 3 0\.2 1 1\.2 尚未連結資料/);
  assert.equal(await rowText('關係人交易小計'), '關係人交易小計 0 0 0 0 — — —');
  assert.ok(await rowText('核心營收'), 'section header row');
  const text = await page.locator('.priority').first().innerText();
  assert.match(text, /毛利參考（不含營業外）：本月已登錄支出 0\.2 萬，預估毛利率 87\.5%；3 案中 1 案已登錄支出，支出還沒登錄齊/);
  assert.match(text, /類別「補助」的專案算營業外收入/);

  // With finance-summary access (synthetic budget: 2C 40 萬, 2B 專案 60 萬, company 100 萬, 營業外 5 萬).
  await page.evaluate(e => { execAllowed = true; EXEC = e; renderPriority(); }, exec);
  assert.equal(await rowText('2C 零售'), '2C 零售 1 0 0.4 0.4 40 1% 39.6');
  assert.match(await rowText('2B 禮盒'), /尚未連結資料/, 'a line without a budget row');
  assert.equal(await rowText('營收合計'), '營收合計 3 0.2 1 1.2 100 1% 98.8');
  assert.equal(await rowText('營業外收入小計（補助）'), '營業外收入小計（補助） 0 0 0 0 5 0% 5');
  const pctStyle = await page.locator('table.monthlines tr.total td').nth(6).locator('b').getAttribute('style');
  assert.match(pctStyle, /var\(--warn\)/, 'below target in red');
  await page.evaluate(() => { const r = { pct: 120, gap: -10, target: 1 }; window.__ok = pctHtml(r) + gapHtml(r); });
  assert.match(await page.evaluate(() => window.__ok), /var\(--ok\)[\s\S]*已達標/, 'reaching the target turns green');

  // Month switch and fallback.
  await page.selectOption('select.finmonth', '10');
  assert.match(await page.locator('.fincards.five').innerText(), /10月 預估營收\s*0\.6\s*萬元/);
  await page.evaluate(() => setFinMonth('99'));
  assert.equal(await page.evaluate(() => finMonth), null);

  // Other views still work.
  await page.locator('[data-ui-click*="setFinMode"][data-ui-click*="cash"]').click();
  assert.equal(await page.locator('table.monthlines').count(), 0);
  assert.match(await page.locator('.fincards').first().innerText(), /2026 Q4 現金流入/);

  // 補助 is offered as a category for admins.
  assert.ok(await page.evaluate(() => { const p = getProject('test-project-1'); return [...new Set([...allCats(), NONOP_CAT, p.cat])].includes('補助'); }));

  const mobile = await login('fake-admin', 390);
  await mobile.page.waitForSelector('table.monthlines');
  assert.ok(await mobile.page.evaluate(() => document.documentElement.scrollWidth <= 390), 'table scrolls inside its box, not the page');
  assert.deepEqual([...problems, ...hp, ...mobile.problems], []);
});
