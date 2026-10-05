'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createFixture } = require('../fixtures/dashboard-fixture.cjs');
const { makeHarness, reply } = require('./offline-dashboard.cjs');
const { preparePreviewHtml, createSyntheticApi, createPreviewHandler, startPreview } = require('../../scripts/preview-synthetic.cjs');

const MINIMAL_HTML = '<html><head><title>Synthetic</title></head><body><script>const SHEET_API_URL="https://invalid.example/synthetic";</script></body></html>';
const payload = (action, code = 'fake-admin', extra = {}) => ({ action, code, ...extra });

async function request(handler, { method = 'GET', url = '/', host = '127.0.0.1:12345', origin, body = '' } = {}) {
  const req = Readable.from([Buffer.from(body)]);
  Object.assign(req, { method, url, headers: { host, ...(origin ? { origin } : {}) } });
  const result = {};
  const response = {
    writeHead(status, headers) { Object.assign(result, { status, headers }); },
    end(value) { result.body = String(value); },
  };
  await handler(req, response);
  return result;
}

test('synthetic fixtures are separate instances containing only invented identities', () => {
  const first = createFixture(), second = createFixture();
  assert.deepEqual(first.users.map(user => user.level), ['admin', 'finance', 'owner', 'none']);
  assert.ok(first.users.every(user => user.name.startsWith('Synthetic ') && user.code.startsWith('fake-')));
  assert.ok(first.catalog.projects.every(project => project.name.startsWith('Synthetic ')));
  first.state['test-project-1'].notes = 'Synthetic changed fixture';
  assert.notEqual(second.state['test-project-1'].notes, first.state['test-project-1'].notes);
});

test('preview rewrites exactly one API URL in memory and refuses residual production hosts', () => {
  const page = preparePreviewHtml(MINIMAL_HTML);
  assert.match(page, /const SHEET_API_URL="\/__test_api__";/);
  assert.match(page, /data-synthetic-preview/);
  for (const code of ['fake-admin', 'fake-finance', 'fake-owner', 'fake-member']) assert.ok(page.includes(code));
  assert.doesNotMatch(page, /script\.google\.com/i);
  assert.throws(() => preparePreviewHtml(MINIMAL_HTML.replace('SHEET_API_URL', 'OTHER_URL')), /exactly one/);
  assert.throws(() => preparePreviewHtml(MINIMAL_HTML.replace('</script>', 'const SHEET_API_URL="duplicate";</script>')), /exactly one/);
  assert.throws(() => preparePreviewHtml(MINIMAL_HTML.replace('</body>', 'script.google.com</body>')), /production script host/);
});

test('synthetic API rejects anonymous calls and redacts each fake role', () => {
  const api = createSyntheticApi();
  assert.equal(api(payload('read', '')).error, 'login_required');
  assert.equal(api(payload('read', 'fake-invalid')).error, 'bad_code');
  const member = api(payload('read', 'fake-member'));
  assert.equal(member.me.level, 'none');
  assert.equal(member.state['test-project-1'].cost, undefined);
  assert.equal(member.state._fin, undefined);
  const owner = api(payload('read', 'fake-owner'));
  assert.equal(owner.state['test-project-1'].cost, 3000);
  assert.equal(owner.state['test-project-2'].cost, undefined);
  assert.equal(api(payload('read', 'fake-finance')).state['test-project-2'].cost, 1000);
});

test('synthetic writes stay in one API instance and preserve protected fake values', () => {
  const api = createSyntheticApi();
  const result = api(payload('write', 'fake-member', { data: {
    'test-project-1': { notes: 'Synthetic memory change', cost: 99999, assignee: 'Synthetic Member' },
  } }));
  assert.equal(result.ok, true);
  const stored = api(payload('read'));
  assert.equal(stored.state['test-project-1'].notes, 'Synthetic memory change');
  assert.equal(stored.state['test-project-1'].cost, 3000);
  assert.equal(stored.state['test-project-1'].assignee, 'Synthetic Owner');
  assert.notEqual(createSyntheticApi()(payload('read')).state['test-project-1'].notes, 'Synthetic memory change');
  assert.equal(api(payload('write', 'fake-admin', { data: JSON.parse('{"__proto__":{}}') })).ok, false);
});

test('preview handler exposes only fixed local routes and blocks foreign origins', async () => {
  const handler = createPreviewHandler({ html: MINIMAL_HTML, vendor: 'synthetic vendor bytes' });
  const page = await request(handler);
  assert.equal(page.status, 200);
  assert.match(page.headers['Content-Security-Policy'], /connect-src 'self'/);
  assert.match(page.headers['Content-Security-Policy'], /script-src-attr 'none'/);
  assert.match(page.headers['Content-Security-Policy'], /form-action 'none'/);
  assert.match(page.headers['Content-Security-Policy'], /base-uri 'none'/);
  assert.equal((await request(handler, { url: '/vendor/xlsx.full.min.js' })).body, 'synthetic vendor bytes');
  for (const url of ['/index.html', '/../index.html', '/.private/Catalog.gs', '/__test_api__', '/?file=anything']) {
    assert.equal((await request(handler, { url })).status, 404);
  }
  assert.equal((await request(handler, { host: 'invalid.example' })).status, 403);
  assert.equal((await request(handler, { origin: 'https://invalid.example' })).status, 403);
  const ping = await request(handler, { url: '/__test_api__?ping=1' });
  assert.deepEqual(JSON.parse(ping.body), { api: 4, authRequired: true, synthetic: true });
  const read = await request(handler, { method: 'POST', url: '/__test_api__', body: JSON.stringify(payload('read')) });
  assert.equal(JSON.parse(read.body).me.name, 'Synthetic Admin');
  assert.equal((await request(handler, { method: 'POST', url: '/__test_api__', body: '{invalid' })).status, 400);
  assert.equal((await request(handler, { method: 'POST', url: '/__test_api__', body: ' '.repeat(512 * 1024 + 1) })).status, 413);
});

test('preview port zero binds only loopback and can be closed without any requests', async () => {
  const { server, url } = await startPreview({ port: 0 });
  try {
    assert.equal(server.address().address, '127.0.0.1');
    assert.ok(server.address().port > 0);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('offline harness retains multiple listeners with capture before bubble', t => {
  const h = makeHarness(t);
  const order = [];
  h.document.addEventListener('synthetic', () => order.push('bubble-1'));
  h.document.addEventListener('synthetic', () => order.push('capture'), true);
  h.document.addEventListener('synthetic', () => order.push('bubble-2'));
  h.document.dispatchEvent({ type: 'synthetic' });
  assert.deepEqual(order, ['capture', 'bubble-1', 'bubble-2']);
  assert.equal(h.calls.length, 0);
});

test('all four synthetic preview roles render the actual application using only queued responses', async t => {
  const api = createSyntheticApi();
  for (const user of createFixture().users) {
    const h = makeHarness(t, {
      session: { dash_code: user.code },
      responses: [reply('ping', { api: 4, authRequired: true }), reply('read', api(payload('read', user.code)))],
    });
    await h.flush();
    assert.equal(h.run('isAuthenticated()'), true);
    assert.equal(h.run('ME.level'), user.level);
    assert.match(h.nodes.get('view').innerHTML, /Synthetic Project One/);
    assert.equal(h.nodes.get('dashboard').hidden, false);
    assert.equal(h.calls.length, 2);
  }
});
