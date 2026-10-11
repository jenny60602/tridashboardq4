'use strict';

// New project statuses (提案中／未成案) and separate note + link fields on tasks and
// subtasks. Synthetic data only.
//   node --test tests/*.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');

let playwright = null;
try { playwright = require('playwright'); } catch { /* optional */ }
const skip = !playwright && 'playwright not installed (set NODE_PATH to a global install to run)';

async function setup(t) {
  const { createServer, HOST } = require('../scripts/preview-synthetic.cjs');
  const { server, api } = createServer();
  await new Promise(r => server.listen(0, HOST, r));
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage();
  const problems = [], dialogs = [];
  page.on('pageerror', e => problems.push(String(e)));
  page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  t.after(async () => { await browser.close(); server.close(); });
  await page.goto(`http://${HOST}:${server.address().port}/`);
  await page.fill('#logincode', 'fake-admin');
  await page.press('#logincode', 'Enter');
  await page.waitForSelector('[data-ui-click*="toggleExpand"]');
  return { page, api, problems, dialogs };
}
const synced = page => page.waitForFunction(() => document.getElementById('synchint').textContent.includes('自動同步中'));

test('browser: six statuses; 未成案 counts as closed, 提案中 is kept out of revenue forecasts', { skip, timeout: 90000 }, async t => {
  const { page, api, problems } = await setup(t);
  await page.locator('[data-ui-click*="toggleExpand"][data-ui-click*="test-project-1"]').first().click();
  const sel = page.locator('select[data-ui-change*="\\"status\\""][data-ui-change*="test-project-1"]').first();
  assert.deepEqual(await sel.locator('option').allTextContents(), ['未開始', '提案中', '進行中', '待收款', '已完成', '未成案']);
  const q4 = () => page.evaluate(() => monthlyTotals().q4Total);
  const before = await q4();
  assert.ok(before > 0);

  await sel.selectOption('提案中');
  await synced(page);
  assert.equal(api.getState()['test-project-1'].status, '提案中', 'server accepted the new status');
  assert.ok(await q4() < before, 'proposal revenue left out of the Q4 forecast');
  await page.waitForSelector('text=提案中 1 案（未計入營收預估）');
  assert.equal(await page.evaluate(() => isClosed(getProject('test-project-1'))), false, 'proposal still gets reminders');

  await page.locator('select[data-ui-change*="\\"status\\""][data-ui-change*="test-project-1"]').first().selectOption('未成案');
  await synced(page);
  assert.equal(api.getState()['test-project-1'].status, '未成案');
  const r = await page.evaluate(() => ({ closed: isClosed(getProject('test-project-1')), urgency: urgency(getProject('test-project-1')),
    alerts: personAlerts('Synthetic Owner'), needs: needsBreakdown(getProject('test-project-1')) }));
  assert.equal(r.closed, true);
  assert.equal(r.urgency, 'later');
  assert.deepEqual(r.alerts, { overdue: 0, soon: 0, unsplit: 0 });
  assert.equal(r.needs, false);
  assert.ok(await q4() < before);
  assert.deepEqual(problems, []);
});

test('browser: top-level tasks and subtasks keep a note and an https link separately', { skip, timeout: 90000 }, async t => {
  const { page, api, problems, dialogs } = await setup(t);
  await page.locator('[data-ui-click*="toggleExpand"][data-ui-click*="test-project-1"]').first().click();
  await page.locator('[data-ui-click*="setDetailTab"][data-ui-click*="\\"tasks\\""]').first().click();

  // Top-level task (母項目)
  const tNote = page.locator('input[data-ui-change*="setTaskNote"]').first();
  await tNote.fill('Synthetic parent note');
  await tNote.press('Tab');
  await synced(page);
  const tLink = page.locator('input[data-ui-change*="setTaskLink"]').first();
  await tLink.fill('https://example.test/parent');
  await tLink.press('Tab');
  await synced(page);
  const tasks = api.getState()['test-project-1'].tasks;
  const parent = Object.values(tasks).find(x => x && x.note === 'Synthetic parent note');
  assert.ok(parent, 'parent note stored');
  assert.equal(parent.link, 'https://example.test/parent');

  // Subtask (子項目): note with text and a link both kept, link icon shown.
  const row = () => page.locator('.subitem', { has: page.locator('input.subname[value="Synthetic checklist"]') });
  const sNote = row().locator('input[data-ui-change*="setSubtaskNote"]');
  await sNote.fill('請先跟客戶確認尺寸');
  await sNote.press('Tab');
  await synced(page);
  const sLink = row().locator('input[data-ui-change*="setSubtaskLink"]');
  await sLink.fill('https://example.test/child');
  await sLink.press('Tab');
  await synced(page);
  const sub = api.getState()['test-project-1'].subtasks['Synthetic planning'][0];
  assert.equal(sub.note, '請先跟客戶確認尺寸');
  assert.equal(sub.link, 'https://example.test/child');
  assert.ok(await page.locator('a[href="https://example.test/child"]').count() >= 1, 'link icon rendered');

  // Non-https link is refused.
  const sLink2 = row().locator('input[data-ui-change*="setSubtaskLink"]');
  await sLink2.fill('javascript:alert(1)');
  await sLink2.press('Tab');
  await page.waitForTimeout(500);
  assert.ok(dialogs.some(m => /https/.test(m)), 'user told the link must be https');
  assert.equal(api.getState()['test-project-1'].subtasks['Synthetic planning'][0].link, 'https://example.test/child');
  assert.deepEqual(problems, []);
});
