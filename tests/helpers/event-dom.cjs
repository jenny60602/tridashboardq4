'use strict';

// A deliberately small offline DOM, not a browser or HTML/script executor.
// Rendered application markup is parsed into a tree. Events follow a fixed
// composed path with capture, bubbling and native cancellation semantics.
const VOID_TAGS = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const decode = value => String(value).replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (whole, entity) => {
  if (entity[0] === '#') return String.fromCodePoint(parseInt(entity.slice(entity[1].toLowerCase() === 'x' ? 2 : 1), entity[1].toLowerCase() === 'x' ? 16 : 10));
  return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }[entity.toLowerCase()] || whole;
});

class TestEvent {
  constructor(type, options = {}) {
    Object.assign(this, { type, bubbles: true, cancelable: true, defaultPrevented: false, cancelBubble: false, eventPhase: 0 }, options);
    this._immediate = false;
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this.cancelBubble = true; }
  stopImmediatePropagation() { this.cancelBubble = true; this._immediate = true; }
  composedPath() { return [...this._path]; }
}

class EventTarget {
  constructor() { this._listeners = new Map(); }
  addEventListener(type, callback, options = {}) {
    const capture = typeof options === 'boolean' ? options : !!options.capture;
    const items = this._listeners.get(type) || [];
    if (!items.some(item => item.callback === callback && item.capture === capture)) {
      items.push({ callback, capture, once: !!options.once });
      this._listeners.set(type, items);
    }
  }
  removeEventListener(type, callback, options = {}) {
    const capture = typeof options === 'boolean' ? options : !!options.capture;
    this._listeners.set(type, (this._listeners.get(type) || []).filter(item => item.callback !== callback || item.capture !== capture));
  }
  listenerCount(type) { return (this._listeners.get(type) || []).length; }
  dispatchEvent(event) {
    const path = [];
    for (let node = this; node; node = node.parentNode) path.push(node);
    event.target = this;
    event._path = path;
    const invoke = (node, capture, phase) => {
      event.currentTarget = node;
      event.eventPhase = phase;
      for (const item of [...(node._listeners?.get(event.type) || [])]) {
        if (item.capture !== capture) continue;
        item.callback.call(node, event);
        if (item.once) node.removeEventListener(event.type, item.callback, capture);
        if (event._immediate) break;
      }
    };
    for (const node of [...path].reverse()) {
      if (node === this) break;
      invoke(node, true, 1);
      if (event.cancelBubble) break;
    }
    if (!event.cancelBubble) {
      invoke(this, true, 2);
      if (!event._immediate) invoke(this, false, 2);
    }
    if (event.bubbles && !event.cancelBubble) {
      for (const node of path.slice(1)) {
        invoke(node, false, 3);
        if (event.cancelBubble) break;
      }
    }
    event.currentTarget = null;
    event.eventPhase = 0;
    return !event.defaultPrevented;
  }
}

function simpleMatches(node, selector) {
  if (node.nodeType !== 1) return false;
  let rest = selector.trim();
  const tag = rest.match(/^[a-z][\w-]*/i);
  if (tag) { if (node.tagName !== tag[0].toUpperCase()) return false; rest = rest.slice(tag[0].length); }
  if (rest === '*') rest = '';
  while (rest) {
    const part = rest.match(/^(?:#([\w-]+)|\.([\w-]+)|\[([^\s=\]]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\])/);
    if (!part) throw new Error('Unsupported test selector: ' + selector);
    if (part[1] && node.id !== part[1]) return false;
    if (part[2] && !node.classList.contains(part[2])) return false;
    if (part[3] && (!node.hasAttribute(part[3]) || (part[4] ?? part[5] ?? part[6]) !== undefined && node.getAttribute(part[3]) !== (part[4] ?? part[5] ?? part[6]))) return false;
    rest = rest.slice(part[0].length);
  }
  return true;
}

function matches(node, selector) {
  return selector.split(',').some(branch => {
    const parts = branch.trim().split(/\s+(?=(?:[^"']|"[^"]*"|'[^']*')*$)/);
    if (!simpleMatches(node, parts.pop())) return false;
    let ancestor = node.parentElement;
    while (parts.length) {
      const part = parts.pop();
      while (ancestor && !simpleMatches(ancestor, part)) ancestor = ancestor.parentElement;
      if (!ancestor) return false;
      ancestor = ancestor.parentElement;
    }
    return true;
  });
}

class Element extends EventTarget {
  constructor(tag, document) {
    super();
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.ownerDocument = document;
    this.parentNode = null;
    this.childNodes = [];
    this._attributes = new Map();
    this._html = '';
    this._value = undefined;
    this.style = {};
    this.scrollLeft = this.scrollTop = 0;
    this.offsetWidth = 1000;
    this.selectionStart = this.selectionEnd = 0;
    this.dataset = new Proxy({}, {
      get: (_, key) => this.getAttribute('data-' + String(key).replace(/[A-Z]/g, value => '-' + value.toLowerCase())) ?? undefined,
      set: (_, key, value) => { this.setAttribute('data-' + String(key).replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()), value); return true; },
    });
    const classes = () => new Set((this.getAttribute('class') || '').split(/\s+/).filter(Boolean));
    this.classList = {
      contains: name => classes().has(name),
      add: (...names) => { const values = classes(); names.forEach(name => values.add(name)); this.setAttribute('class', [...values].join(' ')); },
      remove: (...names) => { const values = classes(); names.forEach(name => values.delete(name)); this.setAttribute('class', [...values].join(' ')); },
      toggle: (name, force) => { const on = force === undefined ? !classes().has(name) : force; this.classList[on ? 'add' : 'remove'](name); return on; },
    };
  }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get children() { return this.childNodes.filter(child => child.nodeType === 1); }
  get isConnected() { let node = this; while (node.parentNode) node = node.parentNode; return node.nodeType === 9; }
  get attributes() { return [...this._attributes].map(([name, value]) => ({ name, value })); }
  getAttribute(name) { return this._attributes.get(name.toLowerCase()) ?? null; }
  getAttributeNames() { return [...this._attributes.keys()]; }
  hasAttribute(name) { return this._attributes.has(name.toLowerCase()); }
  setAttribute(name, value) { this._attributes.set(name.toLowerCase(), String(value)); }
  removeAttribute(name) { this._attributes.delete(name.toLowerCase()); }
  get id() { return this.getAttribute('id') || ''; }
  set id(value) { this.setAttribute('id', value); }
  get className() { return this.getAttribute('class') || ''; }
  set className(value) { this.setAttribute('class', value); }
  get type() { return this.getAttribute('type') || (this.tagName === 'INPUT' ? 'text' : ''); }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(value) { if (value) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  get disabled() { return this.hasAttribute('disabled'); }
  get checked() { return this._checked ?? this.hasAttribute('checked'); }
  set checked(value) { this._checked = !!value; }
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.tagName === 'SELECT') { const choices = this.querySelectorAll('option'); return (choices.find(option => option.hasAttribute('selected')) || choices[0])?.value || ''; }
    return this.getAttribute('value') ?? (['TEXTAREA', 'OPTION'].includes(this.tagName) ? this.textContent : '');
  }
  set value(value) { this._value = String(value); }
  get defaultValue() { return this.getAttribute('value') || ''; }
  get innerHTML() { return this._html; }
  set innerHTML(html) {
    this.childNodes.forEach(child => { child.parentNode = null; });
    this.childNodes = [];
    this._html = String(html);
    parseInto(this, this._html);
  }
  get textContent() { return this.childNodes.map(child => child.textContent).join(''); }
  set textContent(text) { this.childNodes = [{ nodeType: 3, textContent: String(text), parentNode: this }]; this._html = ''; }
  appendChild(child) {
    if (child.parentNode) child.parentNode.childNodes = child.parentNode.childNodes.filter(node => node !== child);
    child.parentNode = this;
    this.childNodes.push(child);
    if (this.tagName === 'HEAD' && child.tagName === 'SCRIPT') this.ownerDocument.scripts.push(child);
    return child;
  }
  matches(selector) { return matches(this, selector); }
  closest(selector) { for (let node = this; node?.nodeType === 1; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  contains(other) { for (let node = other; node; node = node.parentNode) if (node === this) return true; return false; }
  querySelectorAll(selector) {
    const out = [];
    const visit = node => { for (const child of node.children || []) { if (matches(child, selector)) out.push(child); visit(child); } };
    visit(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.ownerDocument.activeElement = this; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  scrollIntoView() {}
}

function parseInto(root, html) {
  const stack = [root];
  const chunks = html.match(/<!--[\s\S]*?-->|<![^>]*>|<\/?[a-zA-Z](?:[^'">]|"[^"]*"|'[^']*')*>|[^<]+|</g) || [];
  for (const chunk of chunks) {
    if (/^<!/.test(chunk)) continue;
    if (/^<\//.test(chunk)) {
      const tag = chunk.match(/^<\/\s*([\w-]+)/)?.[1].toUpperCase();
      const index = stack.findLastIndex(node => node.tagName === tag);
      if (index > 0) stack.length = index;
      continue;
    }
    const start = chunk.match(/^<([\w-]+)/);
    if (!start) { stack.at(-1).childNodes.push({ nodeType: 3, textContent: decode(chunk), parentNode: stack.at(-1) }); continue; }
    const tag = start[1].toLowerCase();
    if (tag === 'option' && stack.at(-1).tagName === 'OPTION') stack.pop();
    const node = new Element(tag, root.ownerDocument);
    const attributes = chunk.slice(start[0].length, -1);
    const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    for (const attr of attributes.matchAll(pattern)) node.setAttribute(attr[1], decode(attr[2] ?? attr[3] ?? attr[4] ?? ''));
    stack.at(-1).appendChild(node);
    if (!VOID_TAGS.has(tag) && !/\/>$/.test(chunk)) stack.push(node);
  }
}

function createEventDOM({ html }) {
  const document = new Element('document');
  document.nodeType = 9;
  document.ownerDocument = document;
  document.scripts = [];
  document.hidden = false;
  document.createElement = tag => new Element(tag, document);
  document.getElementById = id => document.querySelectorAll('[id]').find(node => node.id === id) || null;
  document.defaultView = { Element, HTMLElement: Element, Event: TestEvent };
  document.innerHTML = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  document.documentElement = document.querySelector('html');
  document.body = document.querySelector('body');
  document.head = document.querySelector('head');
  document.activeElement = document.body;
  // Existing harness callers use nodes.get(id), so keep this lookup live after redraw.
  const nodes = { get: id => document.getElementById(id), has: id => !!document.getElementById(id) };
  return { document, nodes, whoami: document.querySelector('.whoami'), scripts: document.scripts };
}

function dataTransfer() {
  const data = new Map();
  return { effectAllowed: '', dropEffect: '', setData: (type, value) => data.set(type, String(value)), getData: type => data.get(type) || '' };
}

module.exports = { createEventDOM, TestEvent, Element, dataTransfer };
