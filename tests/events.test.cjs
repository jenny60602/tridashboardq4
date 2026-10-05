'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeHarness, accepted, reply, ping, HTML, SOURCE } = require('./helpers/offline-dashboard.cjs');
const { createEventDOM, TestEvent, dataTransfer } = require('./helpers/event-dom.cjs');

// Only synthetic fixtures. No Git history, account data, browser or network.
const PID = 'event-p1';
const PERSON = `測試人員 ' " <>&`;
const TASK = `任務 ' " <>& 中文; window.eventExecuted = true;`;
const OTHER_TASK = '另一個合成母項';
const copy = value => JSON.parse(JSON.stringify(value));
function response() {
  return accepted({
    me: { name: PERSON, level: 'admin' },
    catalog: {
      projects: [{ id: PID, cat: '合成類別', name: `合成專案 ' " <>&`, months: [10, 11] }],
      staffGroups: [[PERSON], ['另一位合成人員']], partners: ['合成夥伴'], roles: { [PERSON]: '合成角色' },
    },
    state: {
      [PID]: {
        assignee: PERSON, status: '進行中', driveLink: 'https://fixture.invalid/folder',
        costLink: 'https://fixture.invalid/cost', cost: 25,
        custom: [TASK, OTHER_TASK], taskDeletes: ['企劃', '成本', '報價/合約', '款項', '執行', '結案'],
        subtasks: {
          [TASK]: [
            { id: 'a', name: '合成子項 A', assignee: PERSON },
            { id: 'b', name: '合成子項 B', assignee: PERSON },
            { id: 'c', name: '合成子項 C', assignee: PERSON },
          ],
          [OTHER_TASK]: [{ id: 'd', name: '合成子項 D', assignee: PERSON }],
        },
        receipts: [{ amount: 7, month: 10 }], paymentMethod: '自訂分期', installmentCount: 2,
        estPlan: [{ month: 10, amount: 20 }, { month: 11, amount: 30 }],
        invoices: [{ no: 'SYNTHETIC', date: '2026-10-01', amount: 10 }, {}],
      },
      _fin: { [PID]: { rev: 100, plan: [0, 50, 50, 0] } },
    },
  });
}

function harness(t, options = {}) { return makeHarness(t, { createDOM: createEventDOM, ...options }); }
async function loggedIn(t) {
  const h = harness(t, { session: { dash_code: 'synthetic-event-code' }, responses: [reply('ping', ping), reply('read', response())] });
  await h.flush();
  assert.equal(h.run('isAuthenticated()'), true);
  // These tests exercise real handlers and real rendering. Transport is covered
  // by auth tests and is disabled here, so edits can never leave the fixture.
  h.run('window.eventPersistCount=0; persist=async function(){ window.eventPersistCount++; };');
  return h;
}
function descriptor(node, type) { return JSON.parse(node.getAttribute('data-ui-' + type)); }
function actions(root, type, action) {
  return root.querySelectorAll('[data-ui-' + type + ']').filter(node => descriptor(node, type).action === action);
}
function action(root, type, name, predicate = () => true) {
  const found = actions(root, type, name).find(node => predicate(descriptor(node, type), node));
  assert.ok(found, 'Rendered action exists: ' + type + '.' + name);
  return found;
}
function mount(h, expression) {
  const root = h.document.createElement('section');
  root.innerHTML = h.run(expression);
  h.document.body.appendChild(root);
  return root;
}
async function fire(h, node, type, options = {}) {
  const event = new TestEvent(type, options);
  node.dispatchEvent(event);
  await h.flush();
  return event;
}
async function change(h, node, value, checked) {
  if (value !== undefined) node.value = value;
  if (checked !== undefined) node.checked = checked;
  return fire(h, node, 'change');
}
function row(h) { return h.json(`state[${JSON.stringify(PID)}]`); }
function taskRoot(h, index = 0) { return mount(h, `taskItemHtml(getProject('${PID}'),${index})`); }
function details(h) { return mount(h, `detailRow(getProject('${PID}'))`); }

test('rendered login Enter, login button and replacement logout controls work once', async t => {
  const h = harness(t);
  const input = action(h.document, 'keydown', 'loginEnter');
  input.value = 'synthetic-event-code';
  await fire(h, input, 'keydown', { key: 'Escape' });
  assert.equal(h.calls.length, 0);
  h.add(reply('ping', ping), reply('read', response()));
  await fire(h, input, 'keydown', { key: 'Enter' });
  assert.equal(h.run('isAuthenticated()'), true);
  assert.deepEqual(h.calls.map(call => call.action), ['ping', 'read']);
  await fire(h, action(h.document, 'click', 'logout'), 'click');
  assert.equal(h.run('isAuthenticated()'), false);
  h.nodes.get('logincode').value = 'synthetic-second-code';
  h.add(reply('ping', ping), reply('read', response()));
  await fire(h, action(h.document, 'click', 'login'), 'click');
  assert.equal(h.run('isAuthenticated()'), true);
  assert.deepEqual(h.calls.map(call => call.action), ['ping', 'read', 'ping', 'read']);
});

test('dynamic text round-trips through parsed HTML metadata without becoming code', async t => {
  const h = await loggedIn(t);
  const root = taskRoot(h);
  const start = action(root, 'dragstart', 'handleSubtaskDragStart');
  assert.deepEqual(descriptor(start, 'dragstart').args, [PID, TASK, 0]);
  const transfer = dataTransfer();
  await fire(h, start.querySelector('.draghandle'), 'dragstart', { dataTransfer: transfer });
  assert.deepEqual(JSON.parse(transfer.getData('text/plain')), { pid: PID, fromTask: TASK, si: 0 });
  assert.equal(h.run('dragActive'), true, 'the existing capture listener still observes dragstart');
  const rename = action(root, 'change', 'renameTopTask');
  assert.equal(rename.value, TASK);
  const replacement = `更新後 ' " <>& 中文; window.eventExecuted = true;`;
  await change(h, rename, replacement);
  assert.equal(row(h).custom[0], replacement);
  assert.deepEqual(row(h).subtasks[replacement].map(item => item.id), ['a', 'b', 'c']);
  assert.equal(h.run('typeof window.eventExecuted'), 'undefined');
  const cards = mount(h, `personCard(${JSON.stringify(PERSON)})`);
  await fire(h, action(cards, 'click', 'togglePerson').querySelector('b'), 'click');
  assert.equal(h.run(`expandedPerson.has(${JSON.stringify(PERSON)})`), true);
});

test('change handlers preserve string, checkbox, numeric, empty, trim, clamp and element inputs', async t => {
  const h = await loggedIn(t);
  await change(h, action(h.document, 'change', 'setField', data => data.args[1] === 'status'), '待收款');
  assert.equal(row(h).status, '待收款');
  const root = details(h);
  const cost = action(root, 'change', 'setField', data => data.args[1] === 'cost');
  await change(h, cost, '12.5'); assert.equal(row(h).cost, 12.5);
  await change(h, cost, ''); assert.equal(row(h).cost, null);
  const installments = action(root, 'change', 'setField', data => data.args[1] === 'installmentCount');
  for (const [raw, expected] of [['100', 24], ['-5', 1], ['', 2], ['3', 3]]) {
    await change(h, installments, raw); assert.equal(row(h).installmentCount, expected);
  }
  const invoiceNumber = action(root, 'change', 'setInvField', data => data.args[2] === 'no');
  await change(h, invoiceNumber, '  SYNTHETIC 99  '); assert.equal(row(h).invoices[0].no, 'SYNTHETIC 99');
  const amount = action(root, 'change', 'setInvField', data => data.args[2] === 'amount');
  await change(h, amount, ''); assert.equal(row(h).invoices[0].amount, null);
  const related = action(root, 'change', 'setRelated');
  await change(h, related, undefined, true); assert.equal(row(h).relatedParty, true);
  await change(h, related, undefined, false); assert.equal(row(h).relatedParty, false);
  const link = action(root, 'change', 'setLinkField', data => data.args[1] === 'driveLink');
  await change(h, link, 'javascript:window.eventExecuted=true');
  assert.equal(link.value, 'https://fixture.invalid/folder', 'handler receives and restores the actual element');
  assert.equal(h.alerts.length, 1);
  await change(h, link, '  https://fixture.invalid/updated  ');
  assert.equal(row(h).driveLink, 'https://fixture.invalid/updated');
  const receipts = mount(h, `receiptsHtml(getProject('${PID}'))`);
  const receiptAmount = action(receipts, 'change', 'setReceiptField', data => data.args[2] === 'amount');
  await change(h, receiptAmount, ''); assert.equal(row(h).receipts[0].amount, 0);
  await change(h, receiptAmount, '18'); assert.equal(row(h).receipts[0].amount, 18);
  const month = action(receipts, 'change', 'setReceiptField', data => data.args[2] === 'month');
  await change(h, month, ''); assert.equal(row(h).receipts[0].month, null);
  await change(h, month, '11'); assert.equal(row(h).receipts[0].month, 11);
  const subtasks = taskRoot(h);
  await change(h, action(subtasks, 'change', 'toggleSubtask'), undefined, true);
  assert.equal(row(h).subtasks[TASK][0].done, true);
});

test('nested links and capacity buttons stop parent actions without cancelling link navigation', async t => {
  const h = await loggedIn(t);
  const link = h.document.querySelector('a.drive');
  assert.ok(link);
  const event = await fire(h, link, 'click');
  assert.equal(event.defaultPrevented, false);
  assert.equal(event.cancelBubble, true);
  assert.equal(h.run(`expanded.has('${PID}')`), false);
  const cell = action(h.document, 'click', 'toggleExpand');
  await fire(h, cell.querySelector('.arrow'), 'click');
  assert.equal(h.run(`expanded.has('${PID}')`), true);
  const capacity = mount(h, 'capacityOverviewHtml()');
  const button = action(capacity, 'click', 'moveCapacityPerson');
  const group = button.parentElement.closest('[data-ui-click]');
  const name = descriptor(button, 'click').args[0];
  const before = h.run('capacityExpanded.size');
  await fire(h, button, 'click');
  assert.equal(h.run('capacityExpanded.size'), before);
  assert.equal(descriptor(group, 'click').action, 'toggleCapacityGroup');
  assert.equal(h.run(`capacityExpanded.has(${JSON.stringify(name)})`), false);
});

test('subitem drag highlights stop at rows and dragleave clears row and parent', async t => {
  const h = await loggedIn(t);
  const root = taskRoot(h);
  const rowNode = action(root, 'dragover', 'dragOverRow');
  const task = action(root, 'dragover', 'dragOverTask');
  let event = await fire(h, rowNode.querySelector('.draghandle'), 'dragover', { dataTransfer: dataTransfer() });
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.cancelBubble, true);
  assert.equal(rowNode.classList.contains('dragover-row'), true);
  assert.equal(task.classList.contains('dragover'), false);
  task.classList.add('dragover');
  event = await fire(h, rowNode, 'dragleave');
  assert.equal(event.cancelBubble, false);
  assert.equal(rowNode.classList.contains('dragover-row'), false);
  assert.equal(task.classList.contains('dragover'), false);
  event = await fire(h, task.querySelector('.theader'), 'dragover');
  assert.equal(event.defaultPrevented, true);
  assert.equal(task.classList.contains('dragover'), true);
});

test('row drop retains exact insertion index and prevents the parent append action', async t => {
  const h = await loggedIn(t);
  const source = taskRoot(h);
  const target = taskRoot(h, 1);
  const transfer = dataTransfer();
  await fire(h, action(source, 'dragstart', 'handleSubtaskDragStart', data => data.args[2] === 1), 'dragstart', { dataTransfer: transfer });
  const targetRow = action(target, 'drop', 'dropSubtaskAt');
  targetRow.classList.add('dragover-row');
  const event = await fire(h, targetRow.querySelector('.draghandle'), 'drop', { dataTransfer: transfer });
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.cancelBubble, true);
  assert.equal(targetRow.classList.contains('dragover-row'), false);
  assert.deepEqual(row(h).subtasks[TASK].map(item => item.id), ['a', 'c']);
  assert.deepEqual(row(h).subtasks[OTHER_TASK].map(item => item.id), ['b', 'd']);
  assert.equal(h.run('eventPersistCount'), 1, 'only the row drop mutates and persists');
});

test('same-task reorder, parent append and cross-project rejection preserve prior drag semantics', async t => {
  const h = await loggedIn(t);
  let root = taskRoot(h);
  const transfer = dataTransfer();
  await fire(h, action(root, 'dragstart', 'handleSubtaskDragStart', data => data.args[2] === 2), 'dragstart', { dataTransfer: transfer });
  await fire(h, action(root, 'drop', 'dropSubtaskAt', data => data.args[2] === 0), 'drop', { dataTransfer: transfer });
  assert.deepEqual(row(h).subtasks[TASK].map(item => item.id), ['c', 'a', 'b']);
  root = taskRoot(h);
  await fire(h, action(root, 'dragstart', 'handleSubtaskDragStart', data => data.args[2] === 1), 'dragstart', { dataTransfer: transfer });
  await fire(h, action(taskRoot(h, 1), 'drop', 'dropSubtask'), 'drop', { dataTransfer: transfer });
  assert.deepEqual(row(h).subtasks[TASK].map(item => item.id), ['c', 'b']);
  assert.deepEqual(row(h).subtasks[OTHER_TASK].map(item => item.id), ['d', 'a']);
  const before = copy(row(h));
  transfer.setData('text/plain', JSON.stringify({ pid: 'different-fixture-project', fromTask: TASK, si: 0 }));
  await fire(h, action(taskRoot(h, 1), 'drop', 'dropSubtask'), 'drop', { dataTransfer: transfer });
  assert.deepEqual(row(h), before);
});

test('redraws register no extra listeners and preserve date delay, focus and text selection', async t => {
  const h = await loggedIn(t);
  const types = ['click', 'change', 'keydown', 'dragstart', 'dragover', 'dragleave', 'drop'];
  const counts = types.map(type => h.document.listenerCount(type));
  for (let i = 0; i < 4; i++) h.run('render(); renderLogin();');
  assert.deepEqual(types.map(type => h.document.listenerCount(type)), counts);
  await fire(h, action(h.document, 'click', 'toggleAddForm'), 'click');
  assert.equal(h.run('showAddForm'), true, 'a single click is not toggled twice');
  h.run(`expanded.add('${PID}'); render();`);
  const input = h.nodes.get('startdate-' + PID);
  input.focus();
  await change(h, input, '2026-10-02');
  assert.equal(row(h).startDate, '2026-10-02');
  assert.equal(h.nodes.get('startdate-' + PID), input, 'date rendering remains delayed');
  assert.equal(h.run('isUserBusy()'), true);
  // timers() also advances the recurring poll; a hidden fixture must not poll.
  h.document.hidden = true;
  await h.timers();
  h.document.hidden = false;
  const replacement = h.nodes.get('startdate-' + PID);
  assert.notEqual(replacement, input);
  assert.equal(h.document.activeElement, replacement);
  const text = h.nodes.get('invn-' + PID + '-0');
  text.focus(); text.setSelectionRange(2, 5);
  h.run('render();');
  const newText = h.nodes.get('invn-' + PID + '-0');
  assert.notEqual(newText, text);
  assert.equal(h.document.activeElement, newText);
  assert.deepEqual([newText.selectionStart, newText.selectionEnd], [2, 5]);
});

test('rendered stale controls cannot dispatch mutations while logged out', async t => {
  const h = await loggedIn(t);
  const stale = taskRoot(h);
  const deleteButton = action(stale, 'click', 'deleteSubtask');
  const checkbox = action(stale, 'change', 'toggleSubtask');
  await fire(h, action(h.document, 'click', 'logout'), 'click');
  const count = h.run('eventPersistCount');
  await fire(h, deleteButton, 'click');
  await change(h, checkbox, undefined, true);
  const drag = await fire(h, action(stale, 'dragover', 'dragOverRow'), 'dragover');
  assert.equal(drag.defaultPrevented, false);
  assert.equal(h.run('eventPersistCount'), count);
  assert.deepEqual(h.json('state'), {});
  assert.equal(h.run('isAuthenticated()'), false);
  assert.equal(h.prompts.length, 0);
});

test('malformed metadata, wrong event and prototype/global action names are inert', async t => {
  const h = await loggedIn(t);
  const root = taskRoot(h);
  const button = action(root, 'click', 'deleteSubtask');
  const initial = h.json('state');
  const values = [
    '{', 'null', '[]', JSON.stringify({ action: 'constructor', args: [] }),
    JSON.stringify({ action: '__proto__', args: [] }), JSON.stringify({ action: 'toString', args: [] }),
    JSON.stringify({ action: 'eventTrap', args: [] }), JSON.stringify({ action: 'window.eventTrap()', args: [] }),
    JSON.stringify({ action: 'deleteSubtask', args: {} }), JSON.stringify({ action: 'deleteSubtask', args: [{}] }),
    JSON.stringify({ action: 'deleteSubtask', args: [PID, 0, 0], input: 'constructor' }),
    JSON.stringify({ action: 'deleteSubtask', args: [PID, 0, 0], input: 'unknown' }),
    JSON.stringify({ action: 'deleteSubtask', args: [PID, 0, 0], stop: 'true' }),
    JSON.stringify({ action: 'setField', args: [PID, 'notes', 'wrong event'] }),
  ];
  h.run('window.eventTrap=()=>{ window.eventExecuted=true; };');
  for (const raw of values) { button.setAttribute('data-ui-click', raw); await fire(h, button, 'click'); }
  assert.deepEqual(h.json('state'), initial);
  assert.equal(h.run('eventPersistCount'), 0);
  assert.equal(h.run('typeof window.eventExecuted'), 'undefined');
  assert.deepEqual(h.prompts, []);
});

test('all rendered fragment metadata is inert HTML and resolves to an explicit action table entry', async t => {
  const h = await loggedIn(t);
  assert.doesNotMatch(HTML, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(SOURCE, /\bjsArg\s*\(|\beval\s*\(|\bnew\s+Function\s*\(/);
  for (const tab of ['basic', 'tasks', 'notes']) {
    h.context.syntheticTab = tab;
    h.run(`detailTab['${PID}']=syntheticTab;`);
    details(h);
  }
  for (const expression of [`receiptsHtml(getProject('${PID}'))`, 'capacityOverviewHtml()',
    `personDetailHtml(${JSON.stringify(PERSON)})`, `personCard(${JSON.stringify(PERSON)})`,
    `ganttHtml(getProject('${PID}'))`, 'monthCategoryTableHtml()']) mount(h, expression);
  h.run("showUndoToast('合成刪除'); showRestoreBanner({});");
  const table = h.json('Object.fromEntries(Object.entries(UI_ACTIONS).map(([type,items])=>[type,Object.keys(items)]))');
  let count = 0;
  const seen = new Set();
  for (const node of h.document.querySelectorAll('*')) {
    for (const attr of node.attributes) {
      assert.doesNotMatch(attr.name, /^on/i);
      if (!attr.name.startsWith('data-ui-')) continue;
      const type = attr.name.slice(8);
      const data = JSON.parse(attr.value);
      assert.ok(table[type]?.includes(data.action), type + '.' + data.action);
      seen.add(type);
      count++;
    }
  }
  assert.ok(count > 100, 'Inspect varied real renderer output, not a hand-written descriptor fixture');
  for (const type of ['click', 'change', 'dragstart', 'dragover', 'dragleave', 'drop']) assert.ok(seen.has(type), type);
});
