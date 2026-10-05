'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readCatalogFromGit } = require('../scripts/prepare-catalog.cjs');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SCRIPTS = [...HTML.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(match => !/\bsrc\s*=/.test(match[1])).map(match => match[2]);
assert.equal(SCRIPTS.length, 1, 'Expected one application script');
const SOURCE = SCRIPTS[0];
const SINKS = ['stats', 'priority', 'filters', 'statusfilters', 'ownerfilters', 'addform',
  'view', 'restorebanner', 'undotoast', 'synctoast', 'backbtn'];
const CATALOG = {
  projects: [{ id: 'p1', cat: 'Test', name: 'Secret project', months: [10] }],
  staffGroups: [['Member'], []], partners: [], roles: {},
};
const copy = value => JSON.parse(JSON.stringify(value));
const accepted = (options = {}) => ({
  ok: true,
  me: { name: 'Member', level: 'none' },
  state: { p1: { assignee: 'Member', note: 'Synthetic private note' } },
  catalog: copy(CATALOG),
  ...options,
});
const ping = { api: 4, authRequired: true };
const reply = (action, value) => ({ action, value });

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function storage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: key => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
    clear: () => data.clear(),
  };
}

function makeHarness(t, options = {}) {
  const nodes = new Map();
  const listeners = new Map();
  const scripts = [];
  const timers = new Map();
  let timerId = 0;
  const calls = [], unexpected = [], prompts = [], alerts = [];
  const queue = [...(options.responses || [])];
  let confirmResult = true;
  let document;

  function element(id = '', tag = 'DIV') {
    const classes = new Set();
    let html = '', text = '';
    const localListeners = new Map();
    const node = {
      id, tagName: tag, style: {}, dataset: {}, hidden: false, value: '', defaultValue: '',
      scrollLeft: 0, scrollTop: 0, offsetWidth: 1000,
      classList: {
        add: name => classes.add(name), remove: name => classes.delete(name),
        toggle(name, force) {
          const on = force === undefined ? !classes.has(name) : force;
          if (on) classes.add(name); else classes.delete(name);
          return on;
        },
      },
      addEventListener(name, callback) { localListeners.set(name, callback); },
      dispatch(name, event = {}) { return localListeners.get(name)?.({ target: node, ...event }); },
      focus() { document.activeElement = node; },
      setSelectionRange() {}, scrollIntoView() {},
      appendChild(child) { scripts.push(child); return child; },
      get innerHTML() { return html; },
      set innerHTML(value) {
        html = String(value); text = '';
        for (const match of html.matchAll(/\bid="([^\"]+)"/g)) {
          if (!nodes.has(match[1])) nodes.set(match[1], element(match[1], 'INPUT'));
        }
      },
      get textContent() { return text; },
      set textContent(value) { text = String(value); html = ''; },
    };
    return node;
  }

  for (const match of HTML.slice(0, HTML.indexOf('<script>')).matchAll(/\bid="([^\"]+)"/g)) {
    nodes.set(match[1], element(match[1]));
  }
  const whoami = element('whoami');
  const tabs = ['project', 'person'].map(value => {
    const node = element('', 'BUTTON'); node.dataset.v = value; return node;
  });
  const body = element('', 'BODY');
  document = {
    body, head: element('', 'HEAD'), activeElement: body, hidden: false,
    getElementById: id => nodes.get(id) || null,
    createElement: tag => element('', tag.toUpperCase()),
    querySelector(selector) {
      if (selector === '.whoami') return whoami;
      const tab = selector.match(/^\.tabs button\[data-v="(project|person)"\]$/);
      if (tab) return tabs.find(node => node.dataset.v === tab[1]);
      if (selector.startsWith('#')) return nodes.get(selector.slice(1)) || null;
      return null;
    },
    querySelectorAll: selector => selector === '.tabs button' ? tabs : [],
    addEventListener(name, callback) { listeners.set(name, callback); },
  };
  nodes.get('dashboard').hidden = true;
  nodes.get('stats').hidden = true;
  const sessionStorage = storage(options.session);
  const localStorage = storage(options.local);
  const fixedTime = Date.parse('2026-10-05T04:00:00Z');
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedTime])); }
    static now() { return fixedTime; }
  }
  const context = vm.createContext({
    document, sessionStorage, localStorage, URL, Date: FixedDate,
    console: { log() {}, warn() {}, error() {} },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay, interval: true }); return id; },
    clearInterval(id) { timers.delete(id); },
    alert(message) { alerts.push(message); },
    prompt(message) { prompts.push(message); return null; },
    confirm(message) { prompts.push(message); return confirmResult; },
    scrollY: 0, scrollTo() {},
    async fetch(url, init = {}) {
      // No real fetch, Node networking, credentials or browser is available here.
      const method = init.method || 'GET';
      const body = init.body ? JSON.parse(init.body) : null;
      const action = method === 'GET' ? 'ping' : body?.action;
      calls.push({ method, action, body });
      const expected = queue.shift();
      if (!expected || expected.action !== action || (method === 'GET' && !url.endsWith('?ping=1'))) {
        unexpected.push({ method, action });
        throw new Error('Unexpected mocked request');
      }
      const value = await expected.value;
      if (value instanceof Error) throw value;
      return { ok: true, async json() { return copy(value); } };
    },
  }, { codeGeneration: { strings: false, wasm: false } });
  context.window = context;
  vm.runInContext(SOURCE, context, { timeout: 1000, filename: 'dashboard-inline.js' });
  if (options.mockRender) vm.runInContext('render=function(){refreshAll();};', context);
  t.after(() => assert.deepEqual(unexpected, [], 'Every request must use an explicit offline response'));
  return {
    context, document, nodes, whoami, scripts, calls, prompts, alerts, sessionStorage, localStorage,
    add(...responses) { queue.push(...responses); },
    confirm(value) { confirmResult = value; },
    run(source) { return vm.runInContext(source, context, { timeout: 1000 }); },
    json(source) { return JSON.parse(vm.runInContext(`JSON.stringify(${source})`, context)); },
    async flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); },
    async timers() {
      for (const [id, timer] of [...timers]) {
        if (!timer.interval) timers.delete(id);
        await timer.callback();
      }
    },
  };
}

function assertLocked(h, { codeCleared = true, cacheCleared = true } = {}) {
  assert.equal(h.run('isAuthenticated()'), false);
  assert.equal(h.run('ME'), null);
  for (const name of ['state', 'lastSynced', 'ROLES']) assert.deepEqual(h.json(name), {}, `${name} is empty`);
  for (const name of ['PROJECTS', 'TEAM_STAFF_G1', 'TEAM_STAFF_G2', 'TEAM_STAFF', 'TEAM_PARTNER', 'TEAM', 'ALLP', 'DELETEDP']) {
    assert.deepEqual(h.json(name), [], `${name} is empty`);
  }
  assert.equal(h.run('catalogReady'), false);
  assert.equal(h.document.getElementById('dashboard').hidden, true);
  assert.equal(h.document.getElementById('stats').hidden, true);
  for (const id of SINKS) assert.equal(h.nodes.get(id).innerHTML, '', `${id} is cleared`);
  assert.equal(h.whoami.innerHTML.includes('Member'), false);
  assert.equal(h.run('window._pendingBackup'), null);
  assert.equal(h.run('lastDeleteSnapshot'), null);
  if (codeCleared) assert.equal(h.sessionStorage.getItem('dash_code'), null);
  if (cacheCleared) assert.equal(h.sessionStorage.getItem('dash_backup_v3'), null);
}

async function loggedIn(t, options = {}) {
  const h = makeHarness(t, {
    mockRender: true,
    ...options,
    session: { dash_code: 'synthetic-code', ...options.session },
    responses: [reply('ping', ping), reply('read', options.response || accepted())],
  });
  await h.flush();
  assert.equal(h.run('isAuthenticated()'), true);
  return h;
}

function seedPrivateUi(h) {
  h.run('localBackupSave(); window._pendingBackup=clone(state); lastDeleteSnapshot={pid:"p1",row:clone(state.p1)};');
  for (const id of SINKS) h.nodes.get(id).innerHTML = 'Synthetic private content';
}

test('without a code startup makes no request and direct handlers cannot modify or reveal data', async t => {
  const h = makeHarness(t, {
    session: { dash_backup_v3: JSON.stringify({ owner: 'Member', level: 'none', state: accepted().state }) },
    local: { dash_backup_v2: 'old private data', dash_backup_v3: 'old private data', dash_code: 'old code' },
  });
  await h.flush();
  assertLocked(h);
  const handlers = [...SOURCE.matchAll(/window\.([A-Za-z0-9_]+)\s*=\s*(?:async\s+)?function\s*\(/g)]
    .map(match => match[1]).filter(name => !['login', 'logout'].includes(name));
  assert.ok(handlers.length > 50, 'Exercise the exposed UI handlers, not a small hand-picked subset');
  for (const name of handlers) await h.context[name]('p1', 0, 0, 'synthetic value');
  await h.run('persist()');
  await h.run('pollOnce(true)');
  assertLocked(h);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.prompts, []);
  assert.equal(h.localStorage.getItem('dash_backup_v2'), null);
  assert.equal(h.localStorage.getItem('dash_backup_v3'), null);
  assert.equal(h.localStorage.getItem('dash_code'), null);
});

test('real locked render sinks do not reveal even residual synthetic data', async t => {
  const h = makeHarness(t);
  h.context.synthetic = copy(CATALOG);
  h.run('PROJECTS=synthetic.projects; TEAM=["Member"]; ALLP=PROJECTS; state={p1:{note:"Synthetic private note"}};');
  h.run('render(); renderInner(); renderStats(); renderPriority(); renderFilters(); renderAddForm(); renderProjectView(); renderPersonView(); renderPreservingScroll();');
  for (const id of SINKS) assert.equal(h.nodes.get(id).innerHTML, '', id);
  assert.equal(h.nodes.get('dashboard').hidden, true);
  h.context.logout();
  assertLocked(h);
});

test('a stored code must be verified before unlock; role none renders the real synthetic dashboard', async t => {
  const gate = deferred();
  const h = makeHarness(t, {
    session: { dash_code: 'synthetic-code' },
    responses: [reply('ping', ping), reply('read', gate.promise)],
  });
  await h.flush();
  assert.equal(h.run('isAuthenticated()'), false);
  assert.equal(h.nodes.get('dashboard').hidden, true);
  assert.equal(h.nodes.get('view').innerHTML, '');
  assert.deepEqual(h.calls.map(call => call.action), ['ping', 'read']);
  gate.resolve(accepted());
  await h.flush();
  assert.equal(h.run('isAuthenticated()'), true);
  assert.equal(h.run('ME.level'), 'none');
  assert.equal(h.nodes.get('dashboard').hidden, false);
  assert.match(h.nodes.get('view').innerHTML, /Secret project/);
  assert.match(h.whoami.innerHTML, /Member/);
  assert.equal(h.run('anyFin()'), false);
  assert.equal(h.nodes.get('view').innerHTML.includes('NT$'), false);
  h.context.logout();
  assertLocked(h);
});

test('offline refresh cannot unlock from a stored code or private backup', async t => {
  const h = makeHarness(t, {
    session: {
      dash_code: 'synthetic-code',
      dash_backup_v3: JSON.stringify({ owner: 'Member', level: 'none', state: accepted().state }),
    },
    responses: [reply('ping', new Error('offline'))],
  });
  await h.flush();
  assert.equal(h.run('isAuthenticated()'), false);
  assert.deepEqual(h.json('state'), {});
  assert.deepEqual(h.json('PROJECTS'), []);
  assert.equal(h.nodes.get('view').innerHTML, '');
  assert.equal(h.nodes.get('dashboard').hidden, true);
  assert.equal(h.run('localBackupLoad()'), null);
  await h.context.restoreBackup();
  assert.deepEqual(h.json('state'), {});
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 0);
});

test('bad login clears code, cache, catalog, state and DOM', async t => {
  const h = makeHarness(t);
  h.add(reply('ping', ping), reply('read', { ok: false, error: 'bad_code' }));
  h.nodes.get('logincode').value = 'invalid-synthetic-code';
  await h.context.login();
  assertLocked(h);
  assert.match(h.nodes.get('authnotice').textContent, /密碼不正確/);
});

test('revocation and identity changes clear data before the mass-deletion guard can preserve it', async t => {
  for (const response of [
    { ok: false, error: 'bad_code' },
    { ok: false, error: 'login_required' },
    accepted({ me: { name: 'Different member', level: 'none' }, state: {} }),
    accepted({ me: { name: 'Member', level: 'owner' }, state: {} }),
  ]) {
    const initial = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`p${i}`, { note: 'private' }]));
    initial._customProjects = [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }];
    const h = await loggedIn(t, { response: accepted({ state: initial }) });
    assert.equal(h.run('looksWiped({})'), true);
    seedPrivateUi(h);
    h.add(reply('ping', ping), reply('read', response));
    await h.run('pollOnce(true)');
    assertLocked(h);
  }
});

test('anonymous and malformed successful responses never authenticate', async t => {
  const malformed = [
    null, {}, { ok: true, me: null, state: {}, catalog: copy(CATALOG) },
    accepted({ me: { name: '', level: 'none' } }),
    accepted({ me: { name: 'Member', level: 'unknown' } }),
    accepted({ state: [] }), accepted({ state: { action: 'read' } }),
    accepted({ state: { code: 'should-not-be-state' } }),
    accepted({ catalog: null }), accepted({ error: 'unexpected' }),
    accepted({ catalog: { ...copy(CATALOG), projects: [] } }),
    accepted({ catalog: { ...copy(CATALOG), staffGroups: [[]] } }),
  ];
  for (const response of malformed) {
    const h = makeHarness(t, {
      session: { dash_code: 'synthetic-code' },
      responses: [reply('ping', ping), reply('read', response)],
    });
    await h.flush();
    assertLocked(h);
  }
});

test('old or incomplete backend ping fails closed without posting a read', async t => {
  for (const response of [{ api: 3 }, { api: 4 }, { api: 4, authRequired: false }]) {
    const h = makeHarness(t, {
      session: { dash_code: 'synthetic-code' }, responses: [reply('ping', response)],
    });
    await h.flush();
    assertLocked(h);
    assert.equal(h.calls.filter(call => call.method === 'POST').length, 0);
  }
});

test('logout synchronously clears data and a delayed read cannot restore it', async t => {
  const h = await loggedIn(t);
  seedPrivateUi(h);
  const gate = deferred();
  h.add(reply('ping', ping), reply('read', gate.promise));
  const polling = h.run('pollOnce(true)');
  await h.flush();
  assert.equal(h.calls.at(-1).action, 'read');
  h.context.logout();
  assertLocked(h);
  gate.resolve(accepted());
  await polling;
  assertLocked(h);
});

test('a stale rejected read cannot clear a newer authenticated session', async t => {
  const h = await loggedIn(t);
  const gate = deferred();
  h.add(reply('ping', ping), reply('read', gate.promise));
  const polling = h.run('pollOnce(true)');
  await h.flush();
  h.context.logout();
  h.add(reply('ping', ping), reply('read', accepted()));
  h.nodes.get('logincode').value = 'new-synthetic-code';
  await h.context.login();
  gate.resolve({ ok: false, error: 'bad_code' });
  await polling;
  assert.equal(h.run('isAuthenticated()'), true);
  assert.equal(h.sessionStorage.getItem('dash_code'), 'new-synthetic-code');
});

test('logout during an initial ping prevents the subsequent read', async t => {
  const gate = deferred();
  const h = makeHarness(t, {
    session: { dash_code: 'synthetic-code' }, responses: [reply('ping', gate.promise)],
  });
  h.context.logout();
  assertLocked(h);
  gate.resolve(ping);
  await h.flush();
  assertLocked(h);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 0);
});

test('logout during a write ping prevents both that POST and queued writes', async t => {
  const h = await loggedIn(t);
  h.run('state.p1.note="Unsaved synthetic change";');
  const gate = deferred();
  h.add(reply('ping', gate.promise));
  const first = h.run('persist()');
  const second = h.run('persist()');
  await h.flush();
  assert.equal(h.run('savingCount'), 2);
  h.context.logout();
  assertLocked(h);
  gate.resolve(ping);
  await Promise.all([first, second]);
  assertLocked(h);
  assert.equal(h.calls.filter(call => call.action === 'write').length, 0);
});

test('an already sent write cannot restore the logged-out UI or release a queued write', async t => {
  const h = await loggedIn(t);
  h.run('state.p1.note="Unsaved synthetic change";');
  const gate = deferred();
  h.add(reply('ping', ping), reply('write', gate.promise));
  const first = h.run('persist()');
  const second = h.run('persist()');
  await h.flush();
  assert.equal(h.calls.filter(call => call.action === 'write').length, 1);
  h.context.logout();
  assertLocked(h);
  gate.resolve(accepted());
  await Promise.all([first, second]);
  assertLocked(h);
  assert.equal(h.calls.filter(call => call.action === 'write').length, 1);
});

test('cancelling logout with unsaved changes preserves the session and pending data', async t => {
  const h = await loggedIn(t);
  h.run('state.p1.note="Unsaved synthetic change"; localBackupSave();');
  const before = h.json('state');
  h.confirm(false);
  h.context.logout();
  assert.equal(h.prompts.length, 1, 'Unsaved changes require a discard decision');
  assert.equal(h.run('isAuthenticated()'), true);
  assert.deepEqual(h.json('state'), before);
  assert.notEqual(h.sessionStorage.getItem('dash_backup_v3'), null);
  h.confirm(true);
  h.context.logout();
  assertLocked(h);
});

test('an export awaiting the local vendor script stops after logout', async t => {
  const h = await loggedIn(t);
  const exporting = h.context.exportMonthlyExcel();
  assert.equal(h.scripts.length, 1);
  assert.equal(h.scripts[0].src, './vendor/xlsx.full.min.js');
  h.context.logout();
  assertLocked(h);
  let workbookAccess = 0;
  h.context.XLSX = new Proxy({}, { get(_target, property) {
    // Promise resolution probes then; that is not a workbook/export operation.
    if (property === 'then') return undefined;
    workbookAccess++;
    throw new Error('Export must not resume');
  } });
  h.scripts[0].onload();
  await exporting;
  assert.equal(workbookAccess, 0);
  assertLocked(h);
});

test('finance helpers keep admin, finance, owner and none scopes distinct', async t => {
  const h = await loggedIn(t);
  h.run('ALLP=[...PROJECTS,{id:"p2",cat:"Test",name:"Other synthetic project",months:[10]}]; state.p2={assignee:"Other member"};');
  for (const [level, all, assignee, ids] of [
    ['admin', true, true, ['p1', 'p2']],
    ['finance', true, false, ['p1', 'p2']],
    ['owner', false, false, ['p1']],
    ['none', false, false, []],
  ]) {
    h.context.syntheticLevel = level;
    h.run('ME.level=syntheticLevel;');
    assert.equal(h.run('isAuthenticated()'), true);
    assert.equal(h.run('isFinAll()'), all);
    assert.equal(h.run('canEditAssignee()'), assignee);
    assert.deepEqual(h.json('FINP().map(p=>p.id)'), ids);
    assert.equal(h.run('anyFin()'), ids.length > 0);
  }
});

test('the public source contains no project or person names from the pinned private catalog', () => {
  // Read local Git only. Do not persist the old catalog or print any real names.
  const catalog = readCatalogFromGit(ROOT);
  const names = new Set([
    ...catalog.projects.map(project => project.name),
    ...catalog.staffGroups.flat(), ...catalog.partners, ...Object.keys(catalog.roles),
  ]);
  let leaks = 0;
  for (const name of names) {
    const doubleQuoted = JSON.stringify(name);
    const singleQuoted = `'${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    if (HTML.includes(doubleQuoted) || HTML.includes(singleQuoted)) leaks++;
  }
  assert.equal(leaks, 0, 'Private catalog literals remain in public source (names deliberately omitted)');
});
