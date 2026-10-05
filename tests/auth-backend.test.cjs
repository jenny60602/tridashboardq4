'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'gas', 'Authentication.gs'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const catalogFixture = {
  projects: [{ id: 'example-1', cat: 'Example category', name: 'Example project', months: [9, 10] }],
  staffGroups: [['Example staff'], []],
  partners: ['Example partner'],
  roles: { 'Example staff': 'Example role' }
};
const storedFixture = { p1: { status: 'stored', cost: 123, assignee: 'Example staff' } };

// Snapshot of the supplied pre-change GAS entry points, without private helpers
// or company data. Legitimate writes are compared against this independent
// baseline so changes to lock/guard/merge ordering are observable.
const baseline = `
function doGet(e) {
  if (e && e.parameter && e.parameter.ping) return json_({ api: 3 });
  return json_(redact_(readState_(), null));
}
function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return json_({ok:false,error:'bad_json'}); }
  if (!body || !body.action) return json_({ok:false,error:'please_reload'});
  const user=lookupUser_(body.code);
  const me=(user&&!user.error)?user:null;
  if(body.action==='read')
    return json_({ok:true,me:me,error:user&&user.error,state:redact_(readState_(),me)});
  if(body.action==='write') {
    if(!body.data||typeof body.data!=='object') return json_({ok:false,error:'no_data'});
    const lock=LockService.getScriptLock();lock.waitLock(20000);
    try {
      const stored=readState_();
      const cnt=function(st){return Object.keys(st).filter(function(k){return isRowKey_(k,st[k]);}).length;};
      if(body.data.action!==undefined||body.data.code!==undefined||
         (cnt(stored)>=10&&cnt(body.data)<cnt(stored)*0.5)||
         ((stored._customProjects||[]).length>=3&&!(body.data._customProjects||[]).length))
        return json_({ok:false,error:'rejected_suspicious_write'});
      let merged;
      if(body.base&&typeof body.base==='object'){
        const merged0=mergeState(body.base,body.data,stored);
        merged=mergeWrite_(stored,merged0,me);
      }else{merged=mergeWrite_(stored,body.data,me);}
      writeState_(merged);return json_({ok:true,me:me,state:redact_(merged,me)});
    }finally{lock.releaseLock();}
  }
  return json_({ok:false,error:'unknown_action'});
}
`;

function harness(options = {}) {
  const calls = [];
  const writes = [];
  const stored = clone(options.stored || storedFixture);
  const record = (operation, ...args) => calls.push({ operation, args: clone(args) });
  const context = vm.createContext({
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(content) {
        return { setMimeType: mimeType => ({ content, mimeType }) };
      }
    },
    LockService: {
      getScriptLock() {
        record('getLock');
        return {
          waitLock(timeout) {
            record('waitLock', timeout);
            if (options.failAt === 'waitLock') throw new Error('mock lock failure');
          },
          releaseLock() { record('releaseLock'); }
        };
      }
    },
    lookupUser_(code) {
      record('lookupUser', code);
      if (options.lookup) return options.lookup(code);
      if (typeof code === 'string' && /^(admin|finance|owner|none)-code$/.test(code.trim())) {
        return { name: 'Example user', level: code.trim().split('-')[0] };
      }
      return { error: 'bad_code' };
    },
    readState_() {
      record('readState');
      if (options.failAt === 'readState') throw new Error('mock read failure');
      return clone(stored);
    },
    isRowKey_(key, value) {
      return key.charAt(0) !== '_' && value && typeof value === 'object' && !Array.isArray(value);
    },
    mergeState(base, mine, remote) {
      record('mergeState', base, mine, remote);
      return { p1: { status: 'three-way result' } };
    },
    mergeWrite_(previous, incoming, me) {
      record('mergeWrite', previous, incoming, me);
      // A sentinel returned by the existing policy delegate, not a replacement
      // implementation of financial authorization.
      return { p1: { status: 'policy result', cost: 456 } };
    },
    writeState_(next) {
      record('writeState', next);
      if (options.failAt === 'writeState') throw new Error('mock write failure');
      writes.push(clone(next));
    },
    redact_(state, me) {
      record('redact', state, me);
      return { policyAppliedFor: me ? me.level : 'anonymous', p1: { status: state.p1.status } };
    }
  });
  vm.runInContext(
    'function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }',
    context
  );
  if (!options.omitCatalog) {
    const catalog = options.catalog === undefined ? catalogFixture : options.catalog;
    vm.runInContext('const DASHBOARD_CATALOG = ' + JSON.stringify(catalog) + ';', context);
  }
  vm.runInContext(options.baseline ? baseline : source, context, { filename: 'Authentication.gs' });
  const unwrap = response => {
    assert.equal(response.mimeType, 'application/json');
    return JSON.parse(response.content);
  };
  return {
    calls, writes, context,
    post(body, query = {}) {
      return unwrap(context.doPost({ postData: { contents: JSON.stringify(body) }, parameter: query }));
    },
    rawPost(event) { return unwrap(context.doPost(event)); },
    get(event) { return unwrap(context.doGet(event)); }
  };
}

function assertNoProtectedWork(h, response, expectedError) {
  assert.equal(response.ok, false);
  assert.equal(response.error, expectedError);
  for (const key of ['me', 'state', 'catalog']) assert.equal(Object.hasOwn(response, key), false);
  assert.deepEqual(h.writes, []);
  assert.equal(h.calls.some(call => call.operation !== 'lookupUser'), false);
}

test('the VM exposes no process, require, fetch or browser network APIs', () => {
  const h = harness();
  for (const capability of ['process', 'require', 'fetch', 'XMLHttpRequest', 'WebSocket']) {
    assert.equal(vm.runInContext('typeof ' + capability, h.context), 'undefined');
  }
});

test('GET only permits a data-free capability ping; query credentials do not unlock it', () => {
  for (const event of [undefined, {}, { parameter: {} },
    { parameter: { code: 'admin-code', action: 'read' } }]) {
    const h = harness();
    assertNoProtectedWork(h, h.get(event), 'login_required');
    assert.deepEqual(h.calls, []);
  }
  const h = harness();
  assert.deepEqual(h.get({ parameter: { ping: '1', code: 'admin-code' } }),
    { api: 4, authRequired: true });
  assert.deepEqual(h.calls, []);
});

test('missing and whitespace credentials reject read/write despite forged identity or query credentials', () => {
  for (const action of ['read', 'write']) {
    for (const code of [undefined, null, '', ' \t\r\n ']) {
      const h = harness();
      assertNoProtectedWork(h, h.post({
        action, code, data: storedFixture,
        me: { name: 'Forged', level: 'admin' }, role: 'admin', level: 'admin'
      }, { code: 'admin-code' }), 'login_required');
      assert.deepEqual(h.calls, []);
    }
  }
});

test('invalid, non-string, unavailable and failed credentials never read or return protected data', () => {
  for (const action of ['read', 'write']) {
    for (const code of ['wrong-code', 1, true, [], {}, ['admin-code']]) {
      const h = harness();
      assertNoProtectedWork(h, h.post({ action, code, data: storedFixture }), 'bad_code');
    }
    for (const lookup of [() => null, () => ({ error: 'bad_code' }), () => { throw new Error('mock failure'); }]) {
      const h = harness({ lookup });
      assertNoProtectedWork(h, h.post({ action, code: 'provided-code', data: storedFixture }), 'bad_code');
    }
  }
});

test('malformed JSON, non-object envelopes and unknown actions fail before authentication', () => {
  for (const event of [undefined, {}, { postData: {} }, { postData: { contents: '{' } }]) {
    const h = harness();
    assertNoProtectedWork(h, h.rawPost(event), 'bad_json');
  }
  for (const body of [null, [], 'read', 1, true]) {
    const h = harness();
    assertNoProtectedWork(h, h.post(body), 'bad_request');
  }
  for (const action of [undefined, 'delete', 'READ', ['read'], { name: 'read' }]) {
    const h = harness();
    assertNoProtectedWork(h, h.post({ action, code: 'admin-code' }), 'unknown_action');
    assert.deepEqual(h.calls, []);
  }
});

test('all existing roles, including none, can read with their authenticated identity and original redaction', () => {
  for (const level of ['admin', 'finance', 'owner', 'none']) {
    const h = harness();
    const result = h.post({ action: 'read', code: level + '-code' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.me, { name: 'Example user', level });
    assert.deepEqual(result.state, { policyAppliedFor: level, p1: { status: 'stored' } });
    assert.deepEqual(result.catalog, catalogFixture);
    assert.deepEqual(h.calls.map(call => call.operation), ['lookupUser', 'readState', 'redact']);
    assert.deepEqual(h.calls[2].args, [storedFixture, result.me]);
  }
});

test('body role overrides are ignored and trimmed credentials are resolved only through lookupUser_', () => {
  const h = harness();
  const result = h.post({
    action: 'read', code: '  none-code\n',
    me: { name: 'Forged', level: 'admin' }, role: 'admin', level: 'admin'
  });
  assert.equal(result.me.level, 'none');
  assert.equal(result.state.policyAppliedFor, 'none');
  assert.deepEqual(h.calls[0].args, ['none-code']);
});

test('authenticated writes with and without a base preserve baseline lock/merge/policy flow', () => {
  for (const level of ['admin', 'finance', 'owner', 'none']) {
    for (const withBase of [false, true]) {
      const body = { action: 'write', code: level + '-code', data: { p1: { status: 'edited' } } };
      if (withBase) body.base = storedFixture;
      const previous = harness({ baseline: true });
      const current = harness();
      assert.deepEqual(current.post(body), previous.post(body));
      assert.deepEqual(current.calls, previous.calls);
      assert.deepEqual(current.writes, [{ p1: { status: 'policy result', cost: 456 } }]);
      assert.equal(current.calls.at(-1).operation, 'releaseLock');
      assert.deepEqual(current.calls.find(call => call.operation === 'waitLock').args, [20000]);
      const operations = current.calls.map(call => call.operation);
      assert.equal(operations.includes('mergeState'), withBase);
      assert.ok(operations.indexOf('mergeWrite') < operations.indexOf('writeState'));
      assert.ok(operations.indexOf('redact') > operations.indexOf('writeState'));
    }
  }
});

test('all existing suspicious-write guards preserve baseline rejection and lock release', () => {
  const many = Object.fromEntries(Array.from({ length: 10 }, (_, index) => ['p' + index, {}]));
  const custom = { p1: {}, _customProjects: [{ id: 'x' }, { id: 'y' }, { id: 'z' }] };
  const cases = [
    [storedFixture, { p1: {}, action: 'read' }],
    [storedFixture, { p1: {}, code: 'unexpected' }],
    [many, { p1: {}, p2: {}, p3: {}, p4: {} }],
    [custom, { p1: {}, _customProjects: [] }]
  ];
  for (const [stored, data] of cases) {
    const body = { action: 'write', code: 'admin-code', data, base: stored };
    const previous = harness({ baseline: true, stored });
    const current = harness({ stored });
    assert.deepEqual(current.post(body), previous.post(body));
    assert.deepEqual(current.calls, previous.calls);
    assert.deepEqual(current.writes, []);
    assert.equal(current.calls.at(-1).operation, 'releaseLock');
    assert.equal(current.calls.some(call => call.operation === 'mergeWrite'), false);
  }
});

test('write data and an optional base must be plain objects', () => {
  for (const data of [undefined, null, [], 'state', 123, true]) {
    const h = harness();
    assertNoProtectedWork(h, h.post({ action: 'write', code: 'admin-code', data }), 'no_data');
  }
  for (const base of [null, [], 'state', 123, true]) {
    const h = harness();
    assertNoProtectedWork(h, h.post({ action: 'write', code: 'admin-code', data: {}, base }), 'bad_base');
  }
});

test('catalog setup errors fail closed for authenticated reads and writes without reading State', () => {
  const altered = change => { const value = clone(catalogFixture); change(value); return value; };
  const invalid = [
    null, [], {},
    altered(c => { c.projects = []; }),
    altered(c => { c.projects = {}; }),
    altered(c => { c.projects[0].id = 'unsafe id'; }),
    altered(c => { c.projects[0].id = 'valid\n'; }),
    altered(c => { c.projects[0].id = 'a'.repeat(65); }),
    altered(c => { c.projects[0].id = 1; }),
    altered(c => { c.projects.push(clone(c.projects[0])); }),
    altered(c => { c.projects[0].name = ''; }),
    altered(c => { c.projects[0].cat = 1; }),
    ...[[], [0], [13], [1.5], ['9'], [null]].map(months =>
      altered(c => { c.projects[0].months = months; })),
    altered(c => { c.staffGroups = [['Example staff']]; }),
    altered(c => { c.staffGroups = [[], []]; c.partners = []; }),
    altered(c => { c.staffGroups[0] = 'Example staff'; }),
    altered(c => { c.staffGroups[0] = [1]; }),
    altered(c => { c.partners = {}; }),
    altered(c => { c.partners = [' ']; }),
    altered(c => { c.roles = []; }),
    altered(c => { c.roles['Example staff'] = 1; })
  ];
  for (const action of ['read', 'write']) {
    for (const options of [{ omitCatalog: true }, ...invalid.map(catalog => ({ catalog }))]) {
      const h = harness(options);
      assertNoProtectedWork(h, h.post({ action, code: 'none-code', data: storedFixture }), 'catalog_not_configured');
    }
  }
});

test('catalog output is a whitelist and preserves the configured names, roles and scheduling months', () => {
  const catalog = clone(catalogFixture);
  catalog.projects[0].revenue = 999;
  catalog.projects[0].plan = [999];
  catalog.financialSeed = { hidden: 999 };
  catalog.projects[0].name = 'Example "quoted" project\nline';
  catalog.roles['Example staff'] = 'Existing role';
  const h = harness({ catalog });
  const result = h.post({ action: 'read', code: 'none-code' });
  assert.deepEqual(Object.keys(result.catalog).sort(), ['partners', 'projects', 'roles', 'staffGroups']);
  assert.deepEqual(Object.keys(result.catalog.projects[0]).sort(), ['cat', 'id', 'months', 'name']);
  assert.equal(result.catalog.projects[0].name, catalog.projects[0].name);
  assert.deepEqual(result.catalog.roles, catalog.roles);
  assert.deepEqual(result.catalog.projects[0].months, [9, 10]);
});

test('sparse arrays in a private JavaScript catalog fail schema validation', () => {
  for (const assignment of [
    'DASHBOARD_CATALOG.projects = Array(1)',
    'DASHBOARD_CATALOG.projects[0].months = Array(1)',
    'DASHBOARD_CATALOG.staffGroups = Array(2)',
    'DASHBOARD_CATALOG.staffGroups[0] = Array(1)',
    'DASHBOARD_CATALOG.partners = Array(1)'
  ]) {
    const h = harness();
    vm.runInContext(assignment, h.context);
    assertNoProtectedWork(h, h.post({ action: 'read', code: 'none-code' }), 'catalog_not_configured');
  }
});

test('storage failures retain baseline lock cleanup and do not perform later writes', () => {
  for (const failAt of ['waitLock', 'readState', 'writeState']) {
    const previous = harness({ baseline: true, failAt });
    const current = harness({ failAt });
    const body = { action: 'write', code: 'admin-code', data: storedFixture };
    assert.throws(() => previous.post(body), /mock/);
    assert.throws(() => current.post(body), /mock/);
    assert.deepEqual(current.calls, previous.calls);
    assert.deepEqual(current.writes, []);
    assert.equal(current.calls.some(call => call.operation === 'releaseLock'), failAt !== 'waitLock');
  }
});

test('the baseline anonymous read reaches State while the new entry point does not', () => {
  const previous = harness({ baseline: true, lookup: () => null });
  const current = harness();
  assert.equal(previous.post({ action: 'read' }).ok, true);
  assert.equal(previous.calls.some(call => call.operation === 'readState'), true);
  assertNoProtectedWork(current, current.post({ action: 'read' }), 'login_required');
});
