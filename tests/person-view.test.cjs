'use strict';

// 依人員：提案中預設不算進排程、每人提案摘要、人員比較。Synthetic data only.
//   node --test tests/*.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');

let playwright = null;
try { playwright = require('playwright'); } catch { /* optional */ }
const skip = !playwright && 'playwright not installed (set NODE_PATH to a global install to run)';

async function setup(t, code = 'fake-admin') {
  const { createServer, HOST } = require('../scripts/preview-synthetic.cjs');
  const { server } = createServer();
  await new Promise(r => server.listen(0, HOST, r));
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const problems = [];
  page.on('pageerror', e => problems.push(String(e)));
  t.after(async () => { await browser.close(); server.close(); });
  await page.goto(`http://${HOST}:${server.address().port}/`);
  await page.fill('#logincode', code);
  await page.press('#logincode', 'Enter');
  await page.waitForSelector('[data-ui-click*="toggleExpand"]');
  // Give the synthetic proposal a dated task so it would show up in schedules.
  await page.evaluate(() => {
    state['test-opportunity'] = { ...getRow('test-opportunity'),
      subtasks: { 'Synthetic pitch': [{ id: 'syn-pitch', name: 'Synthetic proposal due', done: false, assignee: 'Synthetic Owner', start: '', end: '2026-11-10' }] } };
    render();
  });
  return { page, problems };
}
const toPersonView = page => page.locator('.tabs button[data-v="person"]').click();

test('browser: proposals are kept out of person schedules by default and can be shown', { skip, timeout: 60000 }, async t => {
  const { page, problems } = await setup(t);
  await toPersonView(page);
  const card = page.locator('#pcard-Synthetic\\ Owner');
  assert.match(await card.innerText(), /提案中 1 件・最近要交：11\/10 Synthetic Opportunity/);
  // Card count of active owned projects excludes the proposal (Owner has 1 active project + 1 proposal).
  assert.match(await card.innerText(), /負責 1\/2 案/);
  await card.click();
  let detail = await page.locator('.persondetail').innerText();
  assert.doesNotMatch(detail, /Synthetic proposal due/, 'proposal task not in the to-do list by default');
  await page.locator('[data-ui-click*="toggleShowProposals"]').first().click();
  detail = await page.locator('.persondetail').innerText();
  assert.match(detail, /Synthetic proposal due/, 'shown after toggling');
  // Capacity overview follows the same switch.
  const caps = await page.evaluate(() => { capacityExpanded.add('Synthetic Owner'); showProposals = false; const a = capacityOverviewHtml().includes('Synthetic Opportunity');
    showProposals = true; const b = capacityOverviewHtml().includes('Synthetic Opportunity'); showProposals = false; return [a, b]; });
  assert.deepEqual(caps, [false, true]);
  assert.deepEqual(problems, []);
});

test('browser: compare view puts up to three people on one weekly timeline', { skip, timeout: 60000 }, async t => {
  const { page, problems } = await setup(t);
  await toPersonView(page);
  for (const n of ['Synthetic Owner', 'Synthetic Partner', 'Synthetic Admin', 'Synthetic Finance']) {
    await page.locator(`[data-ui-click*="toggleCompare"][data-ui-click*="${n}"]`).click();
  }
  assert.deepEqual(await page.evaluate(() => compareSel), ['Synthetic Partner', 'Synthetic Admin', 'Synthetic Finance'], 'keeps the last three');
  assert.equal(await page.locator('.comparetable tr').count(), 4, 'header + three people');
  assert.equal(await page.locator('.comparetable tr').first().locator('th').count(), 9, 'person column + 8 weeks');
  // Pure week bucketing with fixed weeks (independent of today's date).
  const load = await page.evaluate(() => {
    const weeks = [{ start: '2026-10-12', end: '2026-10-18' }, { start: '2026-10-19', end: '2026-10-25' }, { start: '2026-11-09', end: '2026-11-15' }];
    return personWeekLoad('Synthetic Owner', weeks).map(c => [c.tasks.map(x => x.name).sort().join(','), c.events.map(e => e.date).join(',')]);
  });
  assert.deepEqual(load[0][0], 'Synthetic checklist,Synthetic second item', 'subtasks spanning the week');
  assert.equal(load[1][1], '2026-10-20', 'event date of an owned project');
  assert.equal(load[2][0], '', 'proposal task excluded by default');
  assert.deepEqual(problems, []);
});
