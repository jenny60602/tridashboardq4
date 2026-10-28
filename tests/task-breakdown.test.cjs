'use strict';

// "Projects not yet broken down into tasks" list. Synthetic data only.
//   node --test tests/*.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');

let playwright = null;
try { playwright = require('playwright'); } catch { /* optional */ }
const skip = !playwright && 'playwright not installed (set NODE_PATH to a global install to run)';

function withExtraProjects() {
  const fixture = require('./fixtures/dashboard-fixture.cjs');
  const original = fixture.createFixture;
  fixture.createFixture = () => {
    const f = original();
    f.config.projects.push(
      { id: 'untouched-late', cat: 'Test', name: 'Untouched Late Project', months: [12] },
      { id: 'untouched-soon', cat: 'Test', name: 'Untouched Soon Project', months: [10] },
      { id: 'split-none-done', cat: 'Test', name: 'Split But Nothing Done', months: [11] },
      { id: 'assigned-dates', cat: 'Test', name: 'Task Owner Assigned', months: [11] },
      { id: 'finished-untouched', cat: 'Test', name: 'Finished Untouched', months: [10] },
    );
    Object.assign(f.state, {
      'untouched-late': { status: '未開始', assignee: 'Synthetic Owner', startDate: '2026-12-01', endDate: '2026-12-20' },
      'untouched-soon': { status: '進行中', assignee: 'Synthetic Member', startDate: '2026-10-01', endDate: '2026-10-30' },
      'split-none-done': { status: '進行中', assignee: 'Synthetic Owner', startDate: '2026-11-01', endDate: '2026-11-30',
        subtasks: { '企劃': [{ id: 'sx1', name: 'Synthetic step', done: false, assignee: '', start: '', end: '' }] } },
      'assigned-dates': { status: '進行中', assignee: 'Synthetic Owner', startDate: '2026-11-01', endDate: '2026-11-30',
        tasks: { '企劃': { done: false, assignee: 'Synthetic Owner', start: '2026-11-02', end: '2026-11-05' } } },
      'finished-untouched': { status: '已完成', assignee: 'Synthetic Owner', startDate: '2026-10-01', endDate: '2026-10-05' },
    });
    // The two base fixture projects already have custom tasks, i.e. they are broken down.
    return f;
  };
  return () => { fixture.createFixture = original; };
}

test('browser: the not-broken-down and unassigned nag lists are gone; helpers still work',
  { skip, timeout: 90000 }, async t => {
    const restore = withExtraProjects();
    const { createServer, HOST } = require('../scripts/preview-synthetic.cjs');
    const { server } = createServer();
    restore();
    await new Promise(r => server.listen(0, HOST, r));
    const base = `http://${HOST}:${server.address().port}/`;
    const browser = await playwright.chromium.launch();
    t.after(async () => { await browser.close(); server.close(); });
    const page = await browser.newPage();
    const problems = [];
    page.on('pageerror', e => problems.push(String(e)));
    await page.goto(base);
    await page.fill('#logincode', 'fake-admin');
    await page.press('#logincode', 'Enter');
    await page.waitForSelector('[data-ui-click*="toggleExpand"]');
    assert.equal(await page.locator('[data-ui-click*="gotoNoTaskList"]').count(), 0, 'no "還沒拆解" link in the stats');
    assert.equal(await page.locator('[data-ui-click*="setPriorityTab"][data-ui-click*="stagnant"]').count(), 0, 'no 未指派任務 tab');
    await page.locator('.tabs button[data-v="person"]').click();
    assert.equal(await page.locator('#notasklist').count(), 0, 'no not-broken-down list in the person view');
    assert.doesNotMatch(await page.locator('#view').innerText(), /已開始未拆解|所有專案都已指派負責人/);
    // The underlying rule is unchanged (the daily summary uses it): only projects with no breakdown at all.
    const names = await page.evaluate(() => ALLP.filter(needsBreakdown).sort((a, b) => getRange(a).start.localeCompare(getRange(b).start)).map(getName));
    assert.deepEqual(names, ['Untouched Soon Project', 'Untouched Late Project']);
    assert.deepEqual(problems, []);
  });
