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

test('browser: only projects with no breakdown at all are listed, soonest first, with a one-click action',
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
    await page.waitForSelector('[data-ui-click*="gotoNoTaskList"]');

    assert.match(await page.locator('[data-ui-click*="gotoNoTaskList"]').innerText(), /^2 個專案還沒拆解任務$/);
    await page.locator('[data-ui-click*="gotoNoTaskList"]').click();
    await page.waitForSelector('#notasklist');
    const names = await page.locator('#notasklist .pname').evaluateAll(es => es.map(e => e.firstChild.textContent.trim()));
    assert.deepEqual(names, ['Untouched Soon Project', 'Untouched Late Project'], 'sorted by start date; split, assigned and finished projects excluded');

    // One click opens that project's task tab.
    await page.locator('#notasklist [data-ui-click*="goToTaskList"][data-ui-click*="untouched-late"]').click();
    await page.waitForSelector('#proj-untouched-late');
    assert.equal(await page.evaluate(() => detailTab['untouched-late']), 'tasks');
    assert.equal(await page.evaluate(() => view), 'project');

    // Adding one subtask removes it from the list.
    await page.evaluate(() => { state['untouched-late'].subtasks = { '企劃': [{ id: 'new1', name: 'First step', done: false }] }; render(); });
    assert.match(await page.locator('[data-ui-click*="gotoNoTaskList"]').innerText(), /^1 個專案還沒拆解任務$/);
    assert.deepEqual(problems, []);
  });
