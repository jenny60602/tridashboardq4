'use strict';

// XSS regression and Content-Security-Policy checks. Every editable text field in the
// synthetic data carries an injection payload; the page is walked through its views and
// must never turn a payload into a real element or a non-https link.
//   node --test tests/*.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let playwright = null;
try { playwright = require('playwright'); } catch { /* optional */ }
const skip = !playwright && 'playwright not installed (set NODE_PATH to a global install to run)';

const P = tag => `"><img data-xss="${tag}" src=x onerror="window.__xss='${tag}'">'"<b data-xss="${tag}">\${1}</b><script>window.__xss='${tag}'</script>`;

function poisonFixture() {
  const fixturePath = require.resolve('./fixtures/dashboard-fixture.cjs');
  const fixture = require(fixturePath);
  const original = fixture.createFixture;
  fixture.createFixture = () => {
    const f = original();
    const st = f.state, c = f.config;
    c.projects[0].name = 'Proj' + P('pname');
    c.projects[0].cat = 'Cat' + P('pcat');
    c.team.staffG1.push('Staff' + P('staff'));
    c.team.roles['Synthetic Admin'] = 'Role' + P('role');
    const r = st['test-project-1'];
    r.assignee = 'Synthetic Admin';
    r.notes = 'N' + P('notes');
    r.nameOverride = 'NO' + P('nameov');
    r.custom = ['Task' + P('task'), 'Synthetic delivery'];
    r.subtasks = { ['Task' + P('task')]: [{ id: 's1', name: 'Sub' + P('sub'), done: false, assignee: 'Vendor' + P('vendor'),
      start: '2026-10-01', end: '2026-10-09', note: 'https://x.test/"><img data-xss="noteurl" src=x>', audience: 'Aud' + P('aud') }] };
    r.audienceOptions = ['Aud' + P('aud')];
    r.eventDates = [{ date: '2026-10-08', label: 'Ev' + P('event') }];
    r.driveLink = 'javascript:window.__xss="drive"';
    r.costLink = 'https://x.test/"><img data-xss="clink" src=x>';
    r.invoices = [{ date: '2026-10-01', no: 'INV' + P('inv'), amount: 1, dueDate: '2026-10-20', paid: false, paidDate: '' }];
    r.expenses = [{ id: 'e1', item: 'Exp' + P('exp'), amount: 1, month: 10, payDate: '2026-10-10', paid: false, paidDate: '' }];
    st._customProjects = [{ id: 'cust-1', cat: 'CC' + P('ccat'), name: 'CN' + P('cname'), rev: 100 }];
    st['cust-1'] = { status: '進行中', assignee: 'Synthetic Admin', custom: ['T' + P('ctask')] };
    st._inbox = [{ id: 'ib1', from: 'Synthetic Owner', to: 'Synthetic Admin', text: 'Ask' + P('itext'), status: 'sent', ts: Date.now(),
      pid: 'test-project-1', due: '2026-10-20', priority: 'urgent', replies: [{ by: 'Synthetic Owner', text: 'R' + P('rtext'), ts: Date.now() }] }];
    return f;
  };
  return () => { fixture.createFixture = original; };
}

test('production page declares a CSP that blocks inline event attributes and limits connections', () => {
  const m = HTML.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/);
  assert.ok(m, 'CSP meta present');
  const csp = Object.fromEntries(m[1].split(';').map(d => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  assert.deepEqual(csp['script-src-attr'], ["'none'"]);
  assert.deepEqual(csp['object-src'], ["'none'"]);
  assert.deepEqual(csp['base-uri'], ["'none'"]);
  assert.deepEqual(csp['frame-src'], ["'none'"]);
  assert.deepEqual(csp['connect-src'].sort(), ["'self'", 'https://script.google.com', 'https://script.googleusercontent.com'].sort());
  assert.ok(!csp['script-src'].some(v => /^https?:|\*/.test(v)), 'no remote script hosts');
  const api = HTML.match(/const SHEET_API_URL="(https:\/\/[^/]+)/)[1];
  assert.ok(csp['connect-src'].includes(api), 'API host allowed by CSP');
  assert.doesNotMatch(HTML, /(href|src|action)\s*=\s*["']?\s*javascript:/i, 'no javascript: URLs left');
});

test('browser: payloads in every editable field stay text across all views; CSP is enforced', { skip, timeout: 120000 }, async t => {
  const restore = poisonFixture();
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
  page.on('dialog', d => { problems.push('dialog: ' + d.message()); d.dismiss(); });
  await page.goto(base);
  await page.fill('#logincode', 'fake-admin');
  await page.press('#logincode', 'Enter');
  await page.waitForSelector('[data-ui-click*="toggleExpand"]');

  const injected = new Set(), badLinks = new Set(), seenAsText = new Set();
  const scan = async label => {
    const r = await page.evaluate(() => ({
      x: [...document.querySelectorAll('[data-xss]')].map(e => e.getAttribute('data-xss')),
      h: [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')).filter(h => h !== '#' && !h.startsWith('https:')),
      flag: window.__xss || null,
      text: document.body.innerText + [...document.querySelectorAll('input,textarea,select')].map(e => e.value).join('\n'),
    }));
    for (const m of r.text.matchAll(/data-xss="([a-z]+)"/g)) seenAsText.add(m[1]);
    r.x.forEach(v => injected.add(`${label}:${v}`));
    r.h.forEach(v => badLinks.add(`${label}:${v}`));
    if (r.flag) injected.add(`${label}:executed:${r.flag}`);
  };
  const clickAll = async selector => {
    const n = await page.locator(selector).count();
    for (let i = 0; i < n; i++) await page.locator(selector).nth(i).click({ timeout: 2000 }).catch(() => {});
  };

  await scan('initial');
  await clickAll('[data-ui-click*="toggleExpand"]');
  await scan('expanded');
  const detailTabs = await page.locator('[data-ui-click*="setDetailTab"]').evaluateAll(es =>
    [...new Set(es.map(e => JSON.parse(e.getAttribute('data-ui-click')).args[1]))]);
  for (const tab of detailTabs) { await clickAll(`[data-ui-click*="setDetailTab"][data-ui-click*='"${tab}"']`); await scan('detail-' + tab); }
  const prioTabs = await page.locator('[data-ui-click*="setPriorityTab"]').evaluateAll(es =>
    es.map(e => JSON.parse(e.getAttribute('data-ui-click')).args[0]));
  for (const k of prioTabs) { await clickAll(`[data-ui-click*="setPriorityTab"][data-ui-click*='"${k}"']`); await scan('priority-' + k); }
  await clickAll('[data-ui-click*="toggleAllMonths"]'); await scan('months');
  await page.locator('.tabs button[data-v="person"]').click(); await scan('person');
  await clickAll('[data-ui-click*="togglePerson"]'); await scan('person-expanded');
  for (const k of prioTabs) { await clickAll(`[data-ui-click*="setPriorityTab"][data-ui-click*='"${k}"']`); await scan('person-priority-' + k); }
  await clickAll('[data-ui-click*="toggleInbox"]'); await scan('inbox');
  await clickAll('[data-ui-click*="openSchedule"]'); await scan('schedule');

  // The payloads were really rendered (as text or form values), so the walk exercised them.
  for (const tag of ['task', 'sub', 'vendor', 'notes', 'event', 'inv', 'exp', 'itext', 'rtext', 'cname', 'ccat', 'staff', 'nameov']) {
    assert.ok(seenAsText.has(tag), `payload ${tag} was rendered as text (seen: ${[...seenAsText].join(',')})`);
  }
  assert.deepEqual([...injected], [], 'no payload became an element or executed');
  assert.deepEqual([...badLinks], [], 'only https links');

  // CSP blocks an inline handler even if markup were ever injected.
  const violation = await page.evaluate(() => new Promise(resolve => {
    document.addEventListener('securitypolicyviolation', e => resolve(e.violatedDirective), { once: true });
    const d = document.createElement('div');
    d.innerHTML = '<img src="data:," onerror="window.__cspBypass=1">';
    document.body.appendChild(d);
    setTimeout(() => resolve(null), 2000);
  }));
  assert.equal(violation, 'script-src-attr');
  assert.equal(await page.evaluate(() => window.__cspBypass || null), null);
  assert.deepEqual(problems, []);
});

test('browser: Excel export still works under the CSP', { skip, timeout: 60000 }, async t => {
  const { createServer, HOST } = require('../scripts/preview-synthetic.cjs');
  const { server } = createServer();
  await new Promise(r => server.listen(0, HOST, r));
  const base = `http://${HOST}:${server.address().port}/`;
  const browser = await playwright.chromium.launch();
  t.after(async () => { await browser.close(); server.close(); });
  const page = await browser.newPage({ acceptDownloads: true });
  const problems = [];
  page.on('pageerror', e => problems.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
  await page.goto(base);
  await page.fill('#logincode', 'fake-admin');
  await page.press('#logincode', 'Enter');
  await page.waitForSelector('[data-ui-click*="exportMonthlyExcel"]');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.locator('[data-ui-click*="exportMonthlyExcel"]').first().click(),
  ]);
  const file = await download.path();
  const head = fs.readFileSync(file).subarray(0, 2).toString('latin1');
  assert.equal(head, 'PK', 'downloaded file is an xlsx (zip) workbook');
  assert.deepEqual(problems, []);
});
