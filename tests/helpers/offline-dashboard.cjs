'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
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

function addListener(store, name, callback, options = false) {
  const listeners = store.get(name) || [];
  listeners.push({ callback, capture: typeof options === 'boolean' ? options : !!options.capture });
  store.set(name, listeners);
}

function callListeners(store, name, event) {
  for (const listener of [...(store.get(name) || [])].sort((a, b) => Number(b.capture) - Number(a.capture))) {
    listener.callback(event);
  }
}

function makeHarness(t, options = {}) {
  const suppliedDOM = options.dom || options.createDOM?.({ html: HTML, source: SOURCE });
  const nodes = suppliedDOM?.nodes || new Map();
  const listeners = new Map();
  const scripts = suppliedDOM?.scripts || [];
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
      addEventListener(name, callback, options) { addListener(localListeners, name, callback, options); },
      dispatch(name, event = {}) { callListeners(localListeners, name, { type: name, target: node, ...event }); },
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

  if (!suppliedDOM) for (const match of HTML.slice(0, HTML.indexOf('<script>')).matchAll(/\bid="([^\"]+)"/g)) {
    nodes.set(match[1], element(match[1]));
  }
  const whoami = suppliedDOM?.whoami || suppliedDOM?.document.querySelector('.whoami') || element('whoami');
  const tabs = ['project', 'person'].map(value => {
    const node = element('', 'BUTTON'); node.dataset.v = value; return node;
  });
  const body = element('', 'BODY');
  document = suppliedDOM?.document || {
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
    addEventListener(name, callback, options) { addListener(listeners, name, callback, options); },
    dispatchEvent(event) { callListeners(listeners, event.type, event); },
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
    ...(options.globals || {}),
    Element: document.defaultView?.Element || options.globals?.Element,
    HTMLElement: document.defaultView?.HTMLElement || options.globals?.HTMLElement,
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
    element,
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


module.exports = { makeHarness, storage, deferred, reply, accepted, ping, CATALOG, HTML, SOURCE };
