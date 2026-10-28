'use strict';

// 未使用的範本任務：不算進進度、不畫甘特圖、任務清單預設收起。Synthetic data only.
//   node --test tests/*.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');

let playwright = null;
try { playwright = require('playwright'); } catch { /* optional */ }
const skip = !playwright && 'playwright not installed (set NODE_PATH to a global install to run)';

test('browser: idle template tasks are excluded from progress and gantt, and collapsed until used', { skip, timeout: 60000 }, async t => {
  const { createServer, HOST } = require('../scripts/preview-synthetic.cjs');
  const { server } = createServer();
  await new Promise(r => server.listen(0, HOST, r));
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const problems = [];
  page.on('pageerror', e => problems.push(String(e)));
  t.after(async () => { await browser.close(); server.close(); });
  await page.goto(`http://${HOST}:${server.address().port}/`);
  await page.fill('#logincode', 'fake-admin');
  await page.press('#logincode', 'Enter');
  await page.waitForSelector('[data-ui-click*="toggleExpand"]');

  const info = await page.evaluate(() => {
    const p = getProject('test-project-1');
    const all = taskList(p), idle = all.filter(t => isIdleTemplate(p, t));
    return { all: all.length, idle: idle.length, first: idle[0], gantt: ganttRows(p).map(r => (r.group || '') + ':' + r.label).join('|') };
  });
  assert.ok(info.idle > 0 && info.idle < info.all, 'fixture has both used and idle template tasks');
  assert.ok(!info.gantt.includes(info.first), 'idle template not drawn in gantt');

  // Progress counts only tasks in use; using an idle template brings it back.
  const prog = await page.evaluate(name => {
    const p = getProject('test-project-1');
    const before = taskProgress(p);
    const row = getRow(p.id);
    state[p.id] = { ...row, tasks: { ...(row.tasks || {}), [name]: { done: false, assignee: 'Synthetic Owner' } } };
    const after = taskProgress(p);
    const stillIdle = isIdleTemplate(p, name);
    state[p.id] = row;
    return { before, after, stillIdle };
  }, info.first);
  assert.equal(prog.stillIdle, false, 'assigning someone makes it a real task');
  assert.notDeepEqual(prog.after, prog.before, 'progress denominator changes once the template is used');

  // Task list: collapsed by default, toggle shows and hides.
  await page.locator('[data-ui-click*="toggleExpand"][data-ui-click*="test-project-1"]').first().click();
  await page.locator('[data-ui-click*="setDetailTab"][data-ui-click*="\\"tasks\\""]').first().click();
  const toggle = page.locator('[data-ui-click*="toggleTemplates"][data-ui-click*="test-project-1"]').first();
  assert.match(await toggle.innerText(), new RegExp(`顯示 ${info.idle} 個未使用的範本任務`));
  const has = () => page.evaluate(n => [...document.querySelectorAll('input.tname-input')].some(i => i.value === n), info.first);
  assert.equal(await has(), false, 'idle template hidden by default');
  await toggle.click();
  assert.equal(await has(), true, 'shown after toggle');
  assert.match(await page.locator('[data-ui-click*="toggleTemplates"][data-ui-click*="test-project-1"]').first().innerText(), /收起/);
  assert.deepEqual(problems, []);
});
