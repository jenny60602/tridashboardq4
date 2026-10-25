'use strict';

// 機會評估分數卡與業務線. Invented data only; the GAS module runs in a sandbox and the
// browser talks to the 127.0.0.1 stand-in from scripts/preview-synthetic.cjs.
//   node --test tests/*.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function gas(props = {}) {
  const ctx = { JSON, Math, Number, String, Object, Array, Date, isFinite,
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null) }) } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', 'OppScore.gs'), 'utf8'), ctx);
  return ctx;
}
const plain = v => JSON.parse(JSON.stringify(v));
const S = (n = 3) => ({ fin: n, value: n, impact: n, capacity: n, certainty: n, note: '' });
const KNOWN = { p1: 1, p2: 1 };

test('GAS: scorer list fails closed; admins may always score', () => {
  const g = gas();
  assert.deepEqual(plain(g.oppParseScorers_(null)), []);
  assert.deepEqual(plain(g.oppParseScorers_('oops')), []);
  assert.deepEqual(plain(g.oppParseScorers_('[" A ", "", 3, "B"]')), ['A', '3', 'B']);
  assert.equal(g.oppCanScore_({ name: 'X', level: 'admin' }, []), true);
  assert.equal(g.oppCanScore_({ name: 'A', level: 'none' }, ['A']), true);
  assert.equal(g.oppCanScore_({ name: 'B', level: 'finance' }, ['A']), false, 'finance outside the list is denied');
  assert.equal(g.oppCanScore_({ error: 'bad_code' }, ['A']), false);
  assert.equal(g.oppCanScore_(null, ['A']), false);
  assert.equal(plain(gas({ OPP_SCORERS: '["A"]' }).oppScorers_()).join(), 'A');
});

test('GAS: read hides _opp from people outside the list and gives listed people an object', () => {
  const g = gas();
  const stored = { p1: {}, _opp: { p1: { scores: { A: S() }, decision: null } } };
  assert.equal('_opp' in g.oppRedact_({ ...stored }, stored, { name: 'Z', level: 'finance' }, ['A']), false);
  assert.deepEqual(plain(g.oppRedact_({}, stored, { name: 'A', level: 'none' }, ['A'])._opp), stored._opp);
  assert.deepEqual(plain(g.oppRedact_({}, { p1: {} }, { name: 'A', level: 'none' }, ['A'])._opp), {});
});

test('GAS: each person can only add, change or withdraw their own score', () => {
  const g = gas();
  const me = { name: 'A', level: 'none' };
  const stored = { p1: { scores: { B: { ...S(2), at: 1 } }, decision: null } };
  // Tries to add own score, rewrite B's score, and plant a score for C.
  let out = plain(g.oppMerge_(stored, { p1: { scores: { A: S(4), B: S(5), C: S(1) }, decision: { result: '接', reason: 'x' } } }, me, KNOWN, ['A'], 99));
  assert.deepEqual(Object.keys(out.p1.scores).sort(), ['A', 'B']);
  assert.equal(out.p1.scores.B.fin, 2, "someone else's score is untouched");
  assert.equal(out.p1.scores.A.fin, 4); assert.equal(out.p1.scores.A.at, 99, 'time stamped by the server');
  assert.equal(out.p1.decision, null, 'only admins record decisions');
  // Invalid values are refused, not clipped.
  assert.equal(plain(g.oppMerge_(out, { p1: { scores: { A: { ...S(4), fin: 6 }, B: out.p1.scores.B } } }, me, KNOWN, ['A'], 100)).p1.scores.A.fin, 4);
  assert.equal(plain(g.oppMerge_(out, { p1: { scores: { A: { ...S(4), value: 2.5 }, B: out.p1.scores.B } } }, me, KNOWN, ['A'], 100)).p1.scores.A.value, 4);
  // Notes are length-limited and angle brackets neutralised.
  const n = plain(g.oppMerge_(out, { p1: { scores: { A: { ...S(4), note: '<b>' + 'x'.repeat(400) }, B: out.p1.scores.B } } }, me, KNOWN, ['A'], 101));
  assert.equal(n.p1.scores.A.note.length, 300); assert.ok(n.p1.scores.A.note.startsWith('＜b＞'));
  // Unchanged score keeps its time.
  assert.equal(plain(g.oppMerge_(out, { p1: { scores: { A: S(4), B: out.p1.scores.B } } }, me, KNOWN, ['A'], 200)).p1.scores.A.at, 99);
  // Withdraw own score; B's stays. Removing B is ignored.
  out = plain(g.oppMerge_(out, { p1: { scores: {} } }, me, KNOWN, ['A'], 300));
  assert.deepEqual(Object.keys(out.p1.scores), ['B']);
  // Unknown or unsafe project ids are refused.
  const bad = plain(g.oppMerge_({}, { nope: { scores: { A: S() } }, '__proto__': { scores: { A: S() } } }, me, KNOWN, ['A'], 1));
  assert.deepEqual(Object.keys(bad), []);
});

test('GAS: people outside the list cannot write; admins record and clear decisions', () => {
  const g = gas();
  const stored = { p1: { scores: { B: { ...S(2), at: 1 } }, decision: null } };
  assert.deepEqual(plain(g.oppMerge_(stored, { p1: { scores: { Z: S() } } }, { name: 'Z', level: 'finance' }, KNOWN, ['A'], 5)), stored);
  const admin = { name: 'Boss', level: 'admin' };
  let out = plain(g.oppMerge_(stored, { p1: { scores: stored.p1.scores, decision: { result: '先驗證', reason: 'pilot first' } } }, admin, KNOWN, [], 7));
  assert.deepEqual(out.p1.decision, { result: '先驗證', reason: 'pilot first', by: 'Boss', at: 7 });
  assert.equal(plain(g.oppMerge_(out, { p1: { scores: stored.p1.scores, decision: { result: 'maybe' } } }, admin, KNOWN, [], 8)).p1.decision.result, '先驗證', 'unknown result refused');
  out = plain(g.oppMerge_(out, { p1: { scores: {}, decision: null } }, { name: 'B', level: 'none' }, KNOWN, ['B'], 9));
  assert.equal(out.p1.decision.result, '先驗證', 'non-admin cannot clear the decision');
  out = plain(g.oppMerge_(out, { p1: { decision: null } }, admin, KNOWN, [], 10));
  assert.deepEqual(out, {}, 'entry removed once it has no scores and no decision');
});

test('GAS: business line accepts only the listed values', () => {
  const g = gas();
  assert.equal(g.cleanBizLine_(''), null);
  assert.equal(g.cleanBizLine_('企業與通路'), '企業與通路');
  assert.equal(g.cleanBizLine_('專案與公共服務・市集'), '專案與公共服務・市集');
  assert.equal(g.cleanBizLine_('<script>'), undefined);
});

let playwright = null;
try { playwright = require('playwright'); } catch { /* optional */ }
const skip = !playwright && 'playwright not installed (set NODE_PATH to a global install to run)';

async function open(t, code, viewport) {
  const { createServer, HOST } = require('../scripts/preview-synthetic.cjs');
  const { server, api } = createServer();
  await new Promise(r => server.listen(0, HOST, r));
  const browser = await playwright.chromium.launch();
  t.after(async () => { await browser.close(); server.close(); });
  const page = await browser.newPage(viewport ? { viewport } : {});
  const problems = [], bodies = [];
  page.on('pageerror', e => problems.push(String(e)));
  page.on('dialog', d => d.accept());
  page.on('response', async r => { if (r.url().includes('__test_api__')) bodies.push(await r.text().catch(() => '')); });
  await page.goto(`http://${HOST}:${server.address().port}/`);
  await page.fill('#logincode', code);
  await page.press('#logincode', 'Enter');
  await page.waitForSelector('[data-ui-click*="toggleExpand"]');
  return { page, api, problems, bodies };
}
const synced = page => page.waitForFunction(() => document.getElementById('synchint').textContent.includes('自動同步中'));
const expandOpp = async page => {
  await page.locator('[data-ui-click*="toggleExpand"][data-ui-click*="test-opportunity"]').first().click();
  await page.locator('[data-ui-click*="setDetailTab"][data-ui-click*="\\"opp\\""]').first().click();
};

for (const [code, label] of [['fake-member', 'member'], ['fake-ops', 'ops lead (exec viewer but not a scorer)']]) {
  test(`browser: ${label} sees no scorecard and cannot write one`, { skip, timeout: 60000 }, async t => {
    const { page, api, problems, bodies } = await open(t, code);
    assert.equal(await page.evaluate(() => '_opp' in state), false);
    assert.ok(bodies.every(b => !b.includes('Synthetic reason')), 'scores never sent to this user');
    await page.locator('[data-ui-click*="toggleExpand"][data-ui-click*="test-opportunity"]').first().click();
    assert.equal(await page.locator('[data-ui-click*="\\"opp\\""]').count(), 0, 'no 機會評估 tab');
    // Forcing a write directly is ignored by the server.
    await page.evaluate(async () => { state._opp = { 'test-opportunity': { scores: { [myName()]: { fin: 5, value: 5, impact: 5, capacity: 5, certainty: 5, note: '' } } } }; await persist(); });
    assert.deepEqual(Object.keys(api.getState()._opp['test-opportunity'].scores), ['Synthetic Finance']);
    assert.deepEqual(problems, []);
  });
}

test('browser: a listed colleague scores, sees averages and flags, and cannot decide', { skip, timeout: 90000 }, async t => {
  const { page, api, problems } = await open(t, 'fake-owner');
  await expandOpp(page);
  let text = await page.locator('.detailwrap').innerText();
  assert.match(text, /評分人數\s*1 人/);
  assert.match(text, /平均總分\s*15\.0 \/ 25/);
  assert.match(text, /人力可負擔性偏低/, 'capacity 1 is flagged');
  assert.match(text, /Synthetic Finance：Synthetic reason/);
  assert.equal(await page.locator('[data-ui-click*="saveOppDecision"]').count(), 0, 'no decision controls for non-admins');
  assert.equal(await page.locator('[data-ui-click*="saveOppScore"]').isDisabled(), true, 'all five scores required');
  const pick = async (k, v) => { await page.locator(`select[data-ui-change*="setOppDraft"][data-ui-change*='opportunity\\",\\"${k}\\"']`).selectOption(String(v)); };
  await pick('fin', 2); await pick('value', 4); await pick('impact', 5); await pick('capacity', 3); await pick('certainty', 2);
  const note = page.locator('input[data-ui-change*="setOppDraft"][data-ui-change*="\\"note\\""]');
  await note.fill('Synthetic owner view'); await note.press('Tab');
  await page.locator('[data-ui-click*="saveOppScore"]').click();
  await synced(page);
  const s = api.getState()._opp['test-opportunity'].scores;
  assert.deepEqual(Object.keys(s).sort(), ['Synthetic Finance', 'Synthetic Owner']);
  assert.equal(s['Synthetic Owner'].value, 4);
  assert.equal(s['Synthetic Owner'].note, 'Synthetic owner view');
  assert.equal(s['Synthetic Finance'].fin, 4, "the other person's score is untouched");
  text = await page.locator('.detailwrap').innerText();
  assert.match(text, /評分人數\s*2 人/);
  assert.match(text, /長期商業價值意見分歧/, 'value 2 vs 4 is a split');
  assert.match(text, /財務貢獻意見分歧/);
  // Withdraw.
  await page.locator('[data-ui-click*="withdrawOppScore"]').click();
  await synced(page);
  assert.deepEqual(Object.keys(api.getState()._opp['test-opportunity'].scores), ['Synthetic Finance']);
  assert.deepEqual(problems, []);
});

test('browser: the admin records a decision, closes a declined opportunity and sets a business line', { skip, timeout: 90000 }, async t => {
  const { page, api, problems } = await open(t, 'fake-admin');
  await expandOpp(page);
  await page.locator('select[data-ui-change*="setOppDecisionDraft"]').selectOption('不接');
  const reason = page.locator('input[data-ui-change*="setOppDecisionDraft"][data-ui-change*="\\"reason\\""]');
  await reason.fill('Synthetic: no capacity in December'); await reason.press('Tab');
  await page.locator('[data-ui-click*="saveOppDecision"]').click();
  await synced(page);
  const d = api.getState()._opp['test-opportunity'].decision;
  assert.equal(d.result, '不接'); assert.equal(d.by, 'Synthetic Admin'); assert.equal(d.reason, 'Synthetic: no capacity in December');
  await page.locator('[data-ui-click*="closeOppAsLost"]').click();
  await synced(page);
  assert.equal(api.getState()['test-opportunity'].status, '未成案');
  // The tab stays reachable after closing because a decision exists.
  assert.ok(await page.locator('[data-ui-click*="\\"opp\\""]').count() > 0);

  await page.locator('[data-ui-click*="setDetailTab"][data-ui-click*="\\"basic\\""]').first().click();
  const sel = page.locator('select[data-ui-change*="setBizLine"]').first();
  assert.match(await sel.locator('option').first().innerText(), /自動：企業與通路/, '企業 maps to 企業與通路');
  await sel.selectOption('專案與公共服務・市集');
  await synced(page);
  assert.equal(api.getState()['test-opportunity'].bizLine, '專案與公共服務・市集');
  assert.equal(await page.evaluate(() => bizLineOf(getProject('test-opportunity'))), '專案與公共服務');
  assert.equal(await page.evaluate(() => bizLineOf(getProject('test-project-1'))), '待分類', 'unknown category stays unclassified');
  assert.deepEqual(problems, []);
});

test('browser: a non-admin cannot change the business line even by forcing a write', { skip, timeout: 60000 }, async t => {
  const { page, api, problems } = await open(t, 'fake-finance');
  await page.locator('[data-ui-click*="toggleExpand"][data-ui-click*="test-opportunity"]').first().click();
  assert.equal(await page.locator('select[data-ui-change*="setBizLine"]').count(), 0);
  await page.evaluate(async () => { state['test-opportunity'] = { ...state['test-opportunity'], bizLine: '零售與消費者' }; touch('test-opportunity'); await persist(); });
  assert.equal(api.getState()['test-opportunity'].bizLine, undefined);
  assert.deepEqual(problems, []);
});

test('browser: the executive view lists opportunities and business lines (fits a phone)', { skip, timeout: 60000 }, async t => {
  const { page, problems } = await open(t, 'fake-head', { width: 390, height: 844 });
  await page.waitForSelector('#exectab:not([hidden])');
  await page.locator('#exectab').click();
  await page.waitForSelector('.execgrid');
  const text = await page.locator('#view').innerText();
  assert.match(text, /提案中、尚未決定的新機會\s*1 案\s*Synthetic Opportunity\s*1 人評分/);
  assert.match(text, /C\. 新機會評估[\s\S]*Synthetic Opportunity[\s\S]*15\.0 \/ 25[\s\S]*人力可負擔性偏低[\s\S]*未決定/);
  assert.match(text, /D\. 業務線[\s\S]*企業與通路\s*1\s*0\s*0\s*0/);
  assert.match(text, /待分類/);
  assert.doesNotMatch(text, /部門＼業務|週會決策紀錄/);
  const w = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  assert.ok(w[0] <= w[1], `page width ${w[0]} exceeds viewport ${w[1]}`);
  // Link jumps to the scorecard tab of that project.
  await page.locator('[data-ui-click*="goToOpp"]').first().click();
  await page.waitForSelector('.oppform');
  assert.deepEqual(problems, []);
});
