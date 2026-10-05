'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeHarness, reply, accepted, ping, deferred } = require('./helpers/offline-dashboard.cjs');
const { createEventDOM, TestEvent } = require('./helpers/event-dom.cjs');

const KEY = 'dash_backup_v3';
const base = () => ({ p1: { assignee: 'Member', notes: 'Synthetic original', status: '未開始' } });
const draft = (options = {}) => ({
  version: 4, owner: 'Member', level: 'none', base: base(),
  state: { p1: { ...base().p1, notes: 'Synthetic unsent draft', status: '進行中' } },
  savedAt: Date.parse('2026-10-05T03:00:00Z'), uncertain: false, ...options,
});
const writes = h => h.calls.filter(call => call.action === 'write');
const backup = h => JSON.parse(h.sessionStorage.getItem(KEY));

async function loggedIn(t, options = {}) {
  const h = makeHarness(t, {
    mockRender: true, ...options,
    session: { dash_code: 'synthetic-code', ...options.session },
    responses: [reply('ping', ping), reply('read', options.response || accepted({ state: base() }))],
  });
  await h.flush();
  assert.equal(h.run('isAuthenticated()'), true);
  return h;
}

async function withDraft(t, envelope = draft(), response = accepted({ state: base() })) {
  return loggedIn(t, { session: { [KEY]: JSON.stringify(envelope) }, response });
}

function assertNoDeadline(h) {
  assert.equal(h.timerDelays().includes(30000), false, 'Finished requests release their deadline timers');
}

function assertLocked(h) {
  assert.equal(h.run('isAuthenticated()'), false);
  assert.deepEqual(h.json('state'), {});
  assert.equal(h.nodes.get('dashboard').hidden, true);
  assert.equal(h.nodes.get('view').innerHTML, '');
  assert.equal(h.run('window._pendingBackup == null'), true);
}

test('a dirty draft survives reload against nonempty cloud data until an explicit recovery choice', async t => {
  const envelope = draft();
  const h = await withDraft(t, envelope);
  assert.equal(h.run('state.p1.notes'), 'Synthetic original');
  assert.equal(h.run('window._pendingBackup.state.p1.notes'), 'Synthetic unsent draft');
  assert.equal(h.run('localBackupLoad().version'), 4);
  assert.match(h.nodes.get('restorebanner').innerHTML, /復原/);
  assert.equal(h.nodes.get('dashboardcontent').inert, true);
  h.run('localBackupSave()');
  await h.run('persist()');
  await h.run('pollOnce(true)');
  await h.context.manualRefresh();
  await h.fireTimers(15000);
  assert.deepEqual(h.calls.map(call => call.action), ['ping', 'read']);
  assert.deepEqual(backup(h), envelope, 'Startup and background activity must not replace the saved draft');
  assertNoDeadline(h);
});

test('offline startup cannot authenticate or read a saved draft, and preserves it for a verified retry', async t => {
  const envelope = draft();
  const h = makeHarness(t, {
    session: { dash_code: 'synthetic-code', [KEY]: JSON.stringify(envelope) },
    responses: [reply('ping', new Error('synthetic offline'))],
  });
  await h.flush();
  assertLocked(h);
  assert.equal(h.run('localBackupLoad()'), null);
  await h.context.restoreBackup();
  assert.deepEqual(backup(h), envelope);
  assert.equal(writes(h).length, 0);
  assertNoDeadline(h);
  h.add(reply('ping', ping), reply('read', accepted({ state: base() })));
  h.nodes.get('logincode').value = 'synthetic-code';
  await h.context.login();
  assert.equal(h.run('isAuthenticated()'), true);
  assert.equal(h.run('window._pendingBackup.state.p1.notes'), 'Synthetic unsent draft');
  assert.equal(h.run('state.p1.notes'), 'Synthetic original');
  assert.deepEqual(backup(h), envelope);
});

test('drafts from another identity or permission level are never offered or applied', async t => {
  for (const identity of [{ owner: 'Other synthetic member' }, { level: 'admin' }]) {
    const h = await withDraft(t, draft(identity));
    assert.equal(h.run('window._pendingBackup == null'), true);
    assert.equal(h.run('localBackupLoad()'), null);
    assert.equal(h.run('state.p1.notes'), 'Synthetic original');
    assert.equal(h.nodes.get('restorebanner').innerHTML, '');
    assert.equal(writes(h).length, 0);
  }
});

test('legacy drafts without a merge base remain recoverable only through an explicit discard decision', async t => {
  const legacy = { owner: 'Member', level: 'none', state: draft().state };
  const h = await withDraft(t, legacy);
  assert.match(h.nodes.get('restorebanner').innerHTML, /舊版|基準/);
  await h.context.restoreBackup('mine');
  assert.equal(writes(h).length, 0);
  assert.deepEqual(backup(h), legacy);
  h.confirm(false);
  h.context.ignoreBackup();
  assert.notEqual(h.run('window._pendingBackup'), null);
  assert.deepEqual(backup(h), legacy);
  h.confirm(true);
  h.context.ignoreBackup();
  assert.equal(h.run('window._pendingBackup'), null);
  assert.equal(h.sessionStorage.getItem(KEY), null);
  assert.equal(h.nodes.get('restorebanner').innerHTML, '');
  assert.equal(h.nodes.get('dashboardcontent').inert, false);
  assert.equal(h.run('state.p1.notes'), 'Synthetic original');
});

test('discard failure retains the draft and recovery gate instead of claiming it was removed', async t => {
  const h = await withDraft(t);
  h.sessionStorage.removeItem = () => { throw new Error('synthetic storage denial'); };
  h.context.ignoreBackup();
  assert.notEqual(h.run('window._pendingBackup'), null);
  assert.notEqual(backup(h), null);
  assert.equal(h.nodes.get('dashboardcontent').inert, true);
  assert.match(h.nodes.get('backupnotice').textContent, /暫存|清除/);
  assert.equal(writes(h).length, 0);
});

test('recovery reads fresh remote state, merges independent edits, and uses the selected conflict preference', async t => {
  for (const preference of [undefined, 'mine']) {
    const h = await withDraft(t);
    const fresh = { p1: { ...base().p1, notes: 'Synthetic newer cloud', driveLink: 'https://invalid.example/synthetic' } };
    const note = preference === 'mine' ? 'Synthetic unsent draft' : 'Synthetic newer cloud';
    const saved = { p1: { ...fresh.p1, notes: note, status: '進行中' } };
    h.add(reply('ping', ping), reply('read', accepted({ state: fresh })),
      reply('ping', ping), reply('write', accepted({ state: saved })));
    await h.context.restoreBackup(preference);
    assert.deepEqual(h.calls.map(call => call.action), ['ping', 'read', 'ping', 'read', 'ping', 'write']);
    const submitted = writes(h)[0].body;
    assert.equal(submitted.base.p1.notes, 'Synthetic newer cloud', 'The submitted base must be the fresh read');
    assert.equal(submitted.data.p1.notes, note);
    assert.equal(submitted.data.p1.status, '進行中', 'Draft-only changes survive either conflict choice');
    assert.equal(submitted.data.p1.driveLink, 'https://invalid.example/synthetic');
    assert.equal(h.run('state.p1.notes'), note);
    assert.equal(h.run('window._pendingBackup'), null);
    assert.equal(h.sessionStorage.getItem(KEY), null, 'Acknowledged, clean data no longer needs a draft');
    assertNoDeadline(h);
  }
});

test('fresh ownership controls financial projection for both recovery base and submitted draft', async t => {
  const old = { p1: { ...base().p1, actual: 1200, cost: 400, invoices: [{ amount: 1200 }] }, _fin: { p1: { rev: 1200 } } };
  const envelope = draft({ level: 'owner', base: old, state: {
    p1: { ...old.p1, notes: 'Synthetic owner draft', actual: 1800, cost: 500 }, _fin: { p1: { rev: 1800 } },
  } });
  const identity = { name: 'Member', level: 'owner' };
  const h = await withDraft(t, envelope, accepted({ me: identity, state: old }));
  const fresh = { p1: { assignee: 'Other synthetic member', notes: 'Synthetic original', status: '未開始' } };
  const saved = { p1: { ...fresh.p1, notes: 'Synthetic owner draft' } };
  h.add(reply('ping', ping), reply('read', accepted({ me: identity, state: fresh })),
    reply('ping', ping), reply('write', accepted({ me: identity, state: saved })));
  await h.context.restoreBackup('mine');
  const submitted = writes(h)[0].body;
  for (const side of [submitted.base, submitted.data]) {
    assert.equal(side.p1.assignee, 'Other synthetic member');
    for (const field of ['actual', 'cost', 'invoices']) assert.equal(side.p1[field], undefined, field);
    assert.equal(side._fin, undefined);
  }
  assert.equal(submitted.data.p1.notes, 'Synthetic owner draft');
});

test('storage quota failure warns that unsynced edits exist only in memory', async t => {
  const h = await loggedIn(t);
  h.sessionStorage.setItem = () => { throw new Error('synthetic quota exceeded'); };
  h.run('state.p1.notes="Synthetic in-memory edit";');
  h.add(reply('ping', new Error('synthetic offline')));
  await h.run('persist()');
  assert.equal(h.run('state.p1.notes'), 'Synthetic in-memory edit');
  assert.equal(h.sessionStorage.getItem(KEY), null);
  assert.match(h.nodes.get('backupnotice').textContent, /記憶體/);
  assert.match(h.nodes.get('backupnotice').textContent, /重新整理|關閉/);
  assert.equal(h.run('savingCount'), 0);
  assert.equal(writes(h).length, 0);
  assertNoDeadline(h);
});

test('ordinary saves record a merge base and remove the draft only after acknowledgement', async t => {
  const h = await loggedIn(t);
  const gate = deferred();
  h.run('state.p1.notes="Synthetic pending save";');
  h.add(reply('ping', ping), reply('write', gate.promise));
  const saving = h.run('persist()');
  await h.flush();
  const saved = backup(h);
  assert.equal(saved.version, 4);
  assert.equal(saved.owner, 'Member');
  assert.equal(saved.level, 'none');
  assert.equal(saved.base.p1.notes, 'Synthetic original');
  assert.equal(saved.state.p1.notes, 'Synthetic pending save');
  assert.equal(typeof saved.savedAt, 'number');
  assert.equal(saved.uncertain, true, 'A dispatched write is uncertain until its acknowledgement arrives');
  assert.equal(saved.sent.p1.notes, 'Synthetic pending save');
  gate.resolve(accepted({ state: { p1: { ...base().p1, notes: 'Synthetic pending save' } } }));
  await saving;
  assert.equal(h.sessionStorage.getItem(KEY), null);
  assert.equal(h.run('savingCount'), 0);
  assertNoDeadline(h);
});

for (const phase of ['ping', 'read']) {
  for (const bodyOnly of [false, true]) {
    test(`${phase} ${bodyOnly ? 'JSON body' : 'request'} deadline settles startup and blocks a late unlock`, async t => {
      const gate = deferred();
      const delayed = reply(phase, bodyOnly ? {} : gate.promise, bodyOnly ? { json: gate.promise } : {});
      const h = makeHarness(t, {
        session: { dash_code: 'synthetic-code', [KEY]: JSON.stringify(draft()) },
        responses: phase === 'ping' ? [delayed] : [reply('ping', ping), delayed],
      });
      await h.flush();
      assert.equal(h.calls.at(-1).action, phase);
      assert.ok(h.calls.at(-1).signal, 'Every request carries an abort signal');
      await h.fireTimers(30000);
      assertLocked(h);
      assert.equal(h.calls.at(-1).signal.aborted, true);
      assert.match(h.nodes.get('authnotice').textContent, /連線|驗證/);
      assertNoDeadline(h);
      gate.resolve(phase === 'ping' ? ping : accepted({ state: base() }));
      await h.flush();
      assertLocked(h);
      assert.equal(writes(h).length, 0);
      assert.notEqual(h.sessionStorage.getItem(KEY), null);
    });
  }
}

test('a write preflight timeout releases its queue and preserves a retryable draft without an uncertain write', async t => {
  const h = await loggedIn(t);
  const gate = deferred();
  h.run('state.p1.notes="Synthetic unsent timeout edit";');
  h.add(reply('ping', gate.promise));
  const saving = h.run('persist()');
  await h.flush();
  await h.fireTimers(30000);
  await saving;
  assert.equal(h.run('savingCount'), 0);
  assert.equal(h.run('window._pendingBackup == null'), true);
  assert.equal(backup(h).uncertain, false);
  assert.equal(writes(h).length, 0);
  gate.resolve(ping);
  await h.flush();
  assert.equal(writes(h).length, 0, 'An expired preflight cannot proceed to a write');
  assertNoDeadline(h);
});

for (const bodyOnly of [false, true]) {
  test(`a dispatched write ${bodyOnly ? 'JSON body' : 'request'} timeout preserves uncertainty and never retries automatically`, async t => {
    const h = await loggedIn(t);
    const gate = deferred();
    h.run('state.p1.notes="Synthetic uncertain edit";');
    h.add(reply('ping', ping), reply('write', bodyOnly ? {} : gate.promise, bodyOnly ? { json: gate.promise } : {}));
    const first = h.run('persist()');
    const queued = h.run('persist()');
    await h.flush();
    assert.equal(writes(h).length, 1);
    await h.fireTimers(30000);
    await Promise.all([first, queued]);
    assert.equal(h.run('savingCount'), 0);
    assert.equal(h.run('window._pendingBackup.uncertain'), true);
    assert.equal(backup(h).uncertain, true);
    assert.equal(writes(h)[0].signal.aborted, true);
    assert.match(h.nodes.get('restorebanner').innerHTML, /尚未確認|可能/);
    await h.run('persist()');
    await h.run('pollOnce(true)');
    await h.context.manualRefresh();
    await h.fireTimers(15000);
    assert.equal(writes(h).length, 1);
    gate.resolve(accepted({ state: { p1: { ...base().p1, notes: 'Synthetic late acknowledgement' } } }));
    await h.flush();
    assert.equal(h.run('state.p1.notes'), 'Synthetic uncertain edit');
    assert.equal(h.run('window._pendingBackup.uncertain'), true);
    assert.equal(backup(h).uncertain, true);
    assertNoDeadline(h);

    const reloaded = await withDraft(t, backup(h));
    assert.equal(reloaded.run('window._pendingBackup.uncertain'), true);
    await reloaded.run('pollOnce(true)');
    assert.equal(writes(reloaded).length, 0, 'Reload cannot turn an uncertain write into an automatic retry');
  });
}

test('a timed out poll releases its busy flag and can later read successfully', async t => {
  const h = await loggedIn(t);
  const gate = deferred();
  h.add(reply('ping', ping), reply('read', {}, { json: gate.promise }));
  const polling = h.run('pollOnce(true)');
  await h.flush();
  await h.fireTimers(30000);
  await polling;
  assert.equal(h.run('pollBusy'), false);
  assert.equal(h.run('isAuthenticated()'), true);
  assert.equal(h.run('state.p1.notes'), 'Synthetic original');
  h.add(reply('ping', ping), reply('read', accepted({ state: { p1: { ...base().p1, notes: 'Synthetic subsequent cloud' } } })));
  await h.run('pollOnce(true)');
  assert.equal(h.run('state.p1.notes'), 'Synthetic subsequent cloud');
  gate.resolve(accepted({ state: { p1: { ...base().p1, notes: 'Synthetic expired cloud' } } }));
  await h.flush();
  assert.equal(h.run('state.p1.notes'), 'Synthetic subsequent cloud');
  assertNoDeadline(h);
});

test('logout aborts an in-flight write and late completion cannot recreate private state or a draft', async t => {
  const h = await loggedIn(t);
  const gate = deferred();
  h.run('state.p1.notes="Synthetic private pending edit";');
  h.add(reply('ping', ping), reply('write', {}, { json: gate.promise }));
  const saving = h.run('persist()');
  await h.flush();
  const request = writes(h)[0];
  h.context.logout();
  assertLocked(h);
  assert.equal(request.signal.aborted, true);
  assert.equal(h.sessionStorage.getItem(KEY), null);
  await saving;
  assertNoDeadline(h);
  gate.resolve(accepted({ state: { p1: { ...base().p1, notes: 'Synthetic late private state' } } }));
  await h.flush();
  assertLocked(h);
  assert.equal(h.sessionStorage.getItem(KEY), null);
  assert.equal(h.run('savingCount'), 0);
});

test('pending recovery blocks rendered edit actions and rendered recovery buttons select their advertised conflict policy', async t => {
  const h = await loggedIn(t, {
    mockRender: false, createDOM: createEventDOM,
    session: { [KEY]: JSON.stringify(draft()) },
  });
  const findAction = (type, action, predicate = () => true) => h.document.querySelectorAll(`[data-ui-${type}]`).find(node => {
    const metadata = JSON.parse(node.getAttribute(`data-ui-${type}`));
    return metadata.action === action && predicate(metadata);
  });
  const edit = findAction('change', 'setField', metadata => metadata.args[1] === 'status');
  assert.ok(edit, 'The fixture renders a real editable status control');
  edit.value = '待收款';
  edit.dispatchEvent(new TestEvent('change'));
  await h.flush();
  assert.equal(h.run('state.p1.status'), '未開始');
  assert.deepEqual(h.calls.map(call => call.action), ['ping', 'read']);
  const cloud = findAction('click', 'restoreBackup', metadata => metadata.args[0] === 'theirs');
  const mine = findAction('click', 'restoreBackup', metadata => metadata.args[0] === 'mine');
  assert.ok(cloud);
  assert.ok(mine);
  assert.match(cloud.textContent, /雲端/);
  assert.match(mine.textContent, /草稿/);
  assert.ok(findAction('click', 'ignoreBackup'));
  const fresh = { p1: { ...base().p1, notes: 'Synthetic current cloud' } };
  const saved = { p1: { ...fresh.p1, status: '進行中' } };
  h.add(reply('ping', ping), reply('read', accepted({ state: fresh })),
    reply('ping', ping), reply('write', accepted({ state: saved })));
  cloud.dispatchEvent(new TestEvent('click'));
  await h.flush();
  await h.run('saveChain');
  assert.equal(writes(h).length, 1);
  assert.equal(writes(h)[0].body.data.p1.notes, 'Synthetic current cloud');
  assert.equal(writes(h)[0].body.data.p1.status, '進行中');
  assert.equal(h.run('window._pendingBackup'), null);
  assert.equal(h.nodes.get('dashboardcontent').inert, false);
});

test('recovery revalidates credentials and revocation clears the draft without submitting it', async t => {
  const h = await withDraft(t);
  h.add(reply('ping', ping), reply('read', { ok: false, error: 'bad_code' }));
  await h.context.restoreBackup('mine');
  assertLocked(h);
  assert.equal(h.sessionStorage.getItem(KEY), null);
  assert.equal(h.sessionStorage.getItem('dash_code'), null);
  assert.equal(writes(h).length, 0);
  assertNoDeadline(h);
});

for (const committed of [false, true]) {
  test(`an uncertain write preserves a newer local reversal when the dispatched edit ${committed ? 'was committed' : 'was not committed'}`, async t => {
    const h = await loggedIn(t);
    const gate = deferred();
    h.run('state.p1.notes="Synthetic dispatched edit";');
    h.add(reply('ping', ping), reply('write', gate.promise));
    const first = h.run('persist()');
    await h.flush();
    assert.equal(writes(h)[0].body.data.p1.notes, 'Synthetic dispatched edit');
    h.run('state.p1.notes="Synthetic original";');
    const queued = h.run('persist()');
    await h.fireTimers(30000);
    await Promise.all([first, queued]);
    const uncertain = backup(h);
    assert.equal(uncertain.uncertain, true);
    assert.equal(uncertain.base.p1.notes, 'Synthetic original');
    assert.equal(uncertain.state.p1.notes, 'Synthetic original', 'The latest local reversal is preserved');
    assert.equal(uncertain.sent.p1.notes, 'Synthetic dispatched edit', 'The in-flight snapshot remains distinguishable from later local edits');
    assert.equal(h.run('window._pendingBackup.uncertain'), true);
    const remote = committed ? { p1: { ...base().p1, notes: 'Synthetic dispatched edit' } } : base();
    gate.resolve(accepted({ state: remote }));
    await h.flush();
    assert.equal(h.run('state.p1.notes'), 'Synthetic original');

    const reloaded = await withDraft(t, uncertain, accepted({ state: remote }));
    assert.equal(reloaded.run('window._pendingBackup.uncertain'), true,
      'Uncertainty still requires a decision when latest local state equals its old base or current remote');
    assert.equal(backup(reloaded).sent.p1.notes, 'Synthetic dispatched edit');
    reloaded.add(reply('ping', ping), reply('read', accepted({ state: remote })));
    if (committed) reloaded.add(reply('ping', ping), reply('write', accepted({ state: base() })));
    await reloaded.context.restoreBackup('mine');
    assert.equal(reloaded.run('state.p1.notes'), 'Synthetic original');
    assert.equal(reloaded.run('window._pendingBackup'), null);
    assert.equal(reloaded.sessionStorage.getItem(KEY), null);
    assert.equal(writes(reloaded).length, committed ? 1 : 0);
    if (committed) {
      assert.equal(writes(reloaded)[0].body.base.p1.notes, 'Synthetic dispatched edit');
      assert.equal(writes(reloaded)[0].body.data.p1.notes, 'Synthetic original');
    }
    assertNoDeadline(reloaded);
  });
}

test('reload before the write deadline preserves the sent edit and the newer local reversal', async t => {
  const h = await loggedIn(t);
  const gate = deferred();
  h.run('state.p1.notes="Synthetic dispatched edit";');
  h.add(reply('ping', ping), reply('write', gate.promise));
  const first = h.run('persist()');
  await h.flush();
  assert.equal(writes(h).length, 1);
  h.run('state.p1.notes="Synthetic original";');
  const queued = h.run('persist()');
  const snapshot = backup(h);
  assert.equal(snapshot.uncertain, true);
  assert.equal(snapshot.base.p1.notes, 'Synthetic original');
  assert.equal(snapshot.state.p1.notes, 'Synthetic original');
  assert.equal(snapshot.sent.p1.notes, 'Synthetic dispatched edit');
  assert.equal(writes(h)[0].signal.aborted, false, 'The snapshot is taken before timeout or cancellation');
  assert.equal(h.timerDelays().includes(30000), true);

  // Copy the saved tab snapshot to the new VM, then settle the discarded VM's
  // synthetic promises. No deadline or mocked server reply has fired yet.
  const remote = { p1: { ...base().p1, notes: 'Synthetic dispatched edit' } };
  const reloaded = await withDraft(t, snapshot, accepted({ state: remote }));
  h.context.logout();
  await Promise.all([first, queued]);
  gate.resolve(accepted({ state: remote }));
  await h.flush();
  assertNoDeadline(h);
  assert.equal(reloaded.run('window._pendingBackup.uncertain'), true);
  assert.equal(reloaded.run('state.p1.notes'), 'Synthetic dispatched edit', 'Cloud state stays visible until recovery is chosen');
  reloaded.add(reply('ping', ping), reply('read', accepted({ state: remote })),
    reply('ping', ping), reply('write', accepted({ state: base() })));
  await reloaded.context.restoreBackup('mine');
  assert.equal(writes(reloaded).length, 1);
  assert.equal(writes(reloaded)[0].body.base.p1.notes, 'Synthetic dispatched edit');
  assert.equal(writes(reloaded)[0].body.data.p1.notes, 'Synthetic original');
  assert.equal(reloaded.run('state.p1.notes'), 'Synthetic original');
  assert.equal(reloaded.run('window._pendingBackup'), null);
  assert.equal(reloaded.sessionStorage.getItem(KEY), null);
  assertNoDeadline(reloaded);
});

test('a temporary storage read error retains the unread draft and blocks background cleanup', async t => {
  const gate = deferred();
  const raw = JSON.stringify(draft());
  const h = makeHarness(t, {
    mockRender: true,
    session: { dash_code: 'synthetic-code', [KEY]: raw },
    responses: [reply('ping', ping), reply('read', gate.promise)],
  });
  const originalGet = h.sessionStorage.getItem;
  h.sessionStorage.getItem = key => {
    if (key === KEY) throw new Error('synthetic temporary storage read denial');
    return originalGet(key);
  };
  gate.resolve(accepted({ state: base() }));
  await h.flush();
  assert.equal(h.run('isAuthenticated()'), true);
  assert.equal(h.run('window._pendingBackup.unread'), true);
  assert.equal(h.nodes.get('dashboardcontent').inert, true);
  assert.match(h.nodes.get('restorebanner').innerHTML, /無法讀取/);
  assert.equal(originalGet(KEY), raw, 'The unread value must never be replaced with cloud state');
  h.sessionStorage.getItem = originalGet;
  await h.run('pollOnce(true)');
  await h.run('persist()');
  h.run('localBackupSave()');
  await h.fireTimers(15000);
  assert.deepEqual(h.calls.map(call => call.action), ['ping', 'read']);
  assert.equal(h.sessionStorage.getItem(KEY), raw);
  assert.equal(h.run('window._pendingBackup.unread'), true);
  h.confirm(false);
  h.context.ignoreBackup();
  assert.equal(h.sessionStorage.getItem(KEY), raw);
  h.confirm(true);
  h.context.ignoreBackup();
  assert.equal(h.sessionStorage.getItem(KEY), null);
  assert.equal(h.run('window._pendingBackup'), null);
  assertNoDeadline(h);
});

for (const [kind, raw] of [
  ['invalid JSON', '{synthetic malformed JSON'],
  ['invalid state shape', JSON.stringify({ owner: 'Member', level: 'none', state: [] })],
]) {
  test(`a backup containing ${kind} remains untouched until confirmed discard`, async t => {
    const h = await loggedIn(t, { session: { [KEY]: raw } });
    assert.equal(h.run('window._pendingBackup.unread'), true);
    assert.equal(h.sessionStorage.getItem(KEY), raw);
    assert.equal(h.run('state.p1.notes'), 'Synthetic original');
    await h.context.restoreBackup('mine');
    await h.run('pollOnce(true)');
    await h.run('persist()');
    assert.deepEqual(h.calls.map(call => call.action), ['ping', 'read']);
    assert.equal(h.sessionStorage.getItem(KEY), raw);
    h.confirm(false);
    h.context.ignoreBackup();
    assert.equal(h.sessionStorage.getItem(KEY), raw);
    h.confirm(true);
    h.context.ignoreBackup();
    assert.equal(h.sessionStorage.getItem(KEY), null);
    assert.equal(h.run('window._pendingBackup'), null);
    assertNoDeadline(h);
  });
}




