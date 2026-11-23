'use strict';

// 專案財務預估表（精簡版）：萬元卡片、分組長條圖、範圍篩選、年度預算目標。Synthetic data only.
//   node --test tests/*.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');

let playwright = null;
try { playwright = require('playwright'); } catch { /* optional */ }
const skip = !playwright && 'playwright not installed (set NODE_PATH to a global install to run)';

async function login(browser, base, code, width = 1280) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const problems = [];
  page.on('pageerror', e => problems.push(String(e)));
  await page.goto(base);
  await page.fill('#logincode', code);
  await page.press('#logincode', 'Enter');
  await page.waitForSelector('[data-ui-click*="toggleExpand"]');
  return { page, problems };
}

test('browser: finance forecast shows cards, grouped bars, scope filter and cash mode', { skip, timeout: 90000 }, async t => {
  const { createServer, HOST } = require('../scripts/preview-synthetic.cjs');
  const { server } = createServer();
  await new Promise(r => server.listen(0, HOST, r));
  const base = `http://${HOST}:${server.address().port}/`;
  const browser = await playwright.chromium.launch();
  t.after(async () => { await browser.close(); server.close(); });

  const { page, problems } = await login(browser, base, 'fake-admin');
  // 預設是「本月」；這裡檢查「營收與毛利」。
  await page.waitForSelector('table.monthlines');
  await page.locator('[data-ui-click*="setFinMode"][data-ui-click*="rev"]').click();
  await page.waitForSelector('svg.finchart');
  assert.equal(await page.locator('.fincard').count(), 3);
  assert.match(await page.locator('.fincards').innerText(), /2026 Q4 營收預測[\s\S]*萬元/);
  assert.ok(await page.locator('svg.finchart rect.finbar.fc').count() > 0, 'forecast bars drawn');
  assert.equal(await page.locator('svg.finchart rect.finbar.tgt').count(), 0, 'no budget bars without finance-summary access');

  // Scope: one project narrows the totals; whole-company total is restored by choosing 全部.
  const total = () => page.evaluate(() => monthlyTotals('rev').q4Total);
  const all = await total();
  const pid = await page.evaluate(() => FINP().find(p => monthlyTotals('rev') && projectEntries(p, 'rev').length).id);
  await page.selectOption('select.finscope', `p:${pid}`);
  const one = await total();
  assert.ok(one > 0 && one < all, 'single-project scope shows only that project');
  await page.selectOption('select.finscope', '');
  assert.equal(await total(), all);
  // Unknown scope values are rejected.
  await page.evaluate(() => setFinScope('p:not-a-project'));
  assert.equal(await page.evaluate(() => finScope), '');

  // Details + basis behind a toggle.
  assert.equal(await page.locator('.mtable-row').count(), 0);
  await page.locator('[data-ui-click*="toggleAllMonths"]').last().click();
  assert.ok(await page.locator('.mtable-row').count() > 0, 'detail table opens');
  assert.match(await page.locator('.priority').first().innerText(), /營收依發票開立月份認列/);

  // Cash mode.
  await page.locator('[data-ui-click*="setFinMode"][data-ui-click*="cash"]').click();
  assert.match(await page.locator('.fincards').innerText(), /2026 Q4 現金流入[\s\S]*到 12 月累計淨現金流/);

  // Budget target bars appear only for finance-summary viewers, only for FY months, and not for a single project.
  const head = await login(browser, base, 'fake-head');
  await head.page.waitForFunction(() => typeof EXEC !== 'undefined' && EXEC && EXEC.rows.length > 0);
  const exec = await head.page.evaluate(() => EXEC);
  await page.locator('[data-ui-click*="setFinMode"][data-ui-click*="rev"]').click();
  const tgt = await page.evaluate(e => { execAllowed = true; EXEC = e; renderPriority(); const m = finTargetByMonth(); return m && CHART_MONTHS.map(x => m[x] !== null); }, exec);
  assert.deepEqual(tgt, [true, true, true, true, false, false, false], 'budget only for 2026 months');
  assert.ok(await page.locator('svg.finchart rect.finbar.tgt').count() > 0);
  assert.match(await page.locator('.fincards').innerText(), /預測達成 \d+%/);
  await page.selectOption('select.finscope', `p:${pid}`);
  assert.equal(await page.locator('svg.finchart rect.finbar.tgt').count(), 0, 'no company budget for a single project');

  // Phone width: no horizontal page scroll.
  const mobile = await login(browser, base, 'fake-admin', 390);
  await mobile.page.waitForSelector('.fincard');
  assert.ok(await mobile.page.evaluate(() => document.documentElement.scrollWidth <= 390));
  assert.deepEqual([...problems, ...head.problems, ...mobile.problems], []);
});

test('browser: finance chart keeps 1:1 scale on narrow and wide screens (no enlarged text)', { skip, timeout: 90000 }, async t => {
  const { createServer, HOST } = require('../scripts/preview-synthetic.cjs');
  const { server } = createServer();
  await new Promise(r => server.listen(0, HOST, r));
  const base = `http://${HOST}:${server.address().port}/`;
  const browser = await playwright.chromium.launch();
  t.after(async () => { await browser.close(); server.close(); });

  const measure = page => page.evaluate(() => {
    const svg = document.querySelector('svg.finchart');
    const r = svg.getBoundingClientRect();
    const vbW = svg.viewBox.baseVal.width;
    const ax = svg.querySelector('text.finax').getBoundingClientRect();
    return { scale: r.width / vbW, height: r.height, axisTextH: ax.height };
  });
  const out = {};
  for (const width of [800, 1280, 2560]) {
    const { page, problems } = await login(browser, base, 'fake-admin', width);
    await page.waitForSelector('svg.finchart');
    await page.waitForTimeout(300);
    out[width] = await measure(page);
    assert.ok(Math.abs(out[width].scale - 1) < 0.02, `scale ~1 at ${width}px (got ${out[width].scale})`);
    assert.ok(Math.abs(out[width].height - 240) < 6, `chart height stays ~240px at ${width}px`);
    // Resize the window: chart re-fits its container, still at 1:1.
    // Opened in a small window, then made fullscreen (the reported case) — and the reverse.
    await page.setViewportSize({ width: width < 2000 ? 2560 : 1000, height: 900 });
    await page.waitForTimeout(500);
    const after = await measure(page);
    assert.ok(Math.abs(after.scale - 1) < 0.02, `scale ~1 after resize from ${width}px (got ${after.scale})`);
    assert.deepEqual(problems, []);
    await page.close();
  }
  assert.ok(Math.abs(out[1280].axisTextH - out[2560].axisTextH) < 1.5, 'axis text same size on both widths');
});
