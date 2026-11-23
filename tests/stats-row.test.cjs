'use strict';

// 上方統計區：一行四張卡（專案總數、2026Q4、2027Q1、提案中），沒有任務完成率。Synthetic data only.
//   node --test tests/*.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');

let playwright = null;
try { playwright = require('playwright'); } catch { /* optional */ }
const skip = !playwright && 'playwright not installed (set NODE_PATH to a global install to run)';

test('browser: stats fit one row, no task completion rate, finance cards only for finance users', { skip, timeout: 90000 }, async t => {
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
    await page.waitForSelector('#stats .stat');
    return { page, problems };
  };

  const { page, problems } = await login('fake-admin');
  const text = await page.locator('#stats').innerText();
  assert.doesNotMatch(text, /任務完成率/);
  assert.match(text, /專案總數/);
  assert.match(text, /2026Q4 營收預估（未稅）\s*毛利率 -?\d+%・毛利 -?[\d.,]+ 萬/);
  assert.match(text, /2027Q1 營收預估（未稅）/);
  assert.match(text, /提案中 \d+ 案\s*未計入營收預估/);
  const n = await page.locator('#stats .stat').count();
  assert.equal(n, 4);
  const tops = await page.locator('#stats .stat').evaluateAll(els => [...new Set(els.map(e => Math.round(e.getBoundingClientRect().top)))]);
  assert.equal(tops.length, 1, 'all cards on one row at desktop width');
  // Numbers match the existing calculation.
  const expect = await page.evaluate(() => { const mt = monthlyTotals(); const { q4Cost } = quarterCost();
    return { total: wan(mt.q4Total), gm: mt.q4Total ? Math.round((mt.q4Total - q4Cost) / mt.q4Total * 100) + '%' : '—' }; });
  const q4 = await page.locator('#stats .stat.wide').first().innerText();
  assert.ok(q4.startsWith(expect.total), q4);
  assert.ok(q4.includes('毛利率 ' + expect.gm), q4);
  assert.match(await page.locator('#stats .stat.wide').first().getAttribute('title'), /核心 .*／關係人 .*／營業外 /);

  const owner = await login('fake-member');
  const ot = await owner.page.locator('#stats').innerText();
  assert.doesNotMatch(ot, /任務完成率/);

  const mobile = await login('fake-admin', 390);
  assert.ok(await mobile.page.evaluate(() => document.documentElement.scrollWidth <= 390));
  assert.deepEqual([...problems, ...owner.problems, ...mobile.problems], []);
});
