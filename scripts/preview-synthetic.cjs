'use strict';

// Local synthetic preview only. It serves index.html with the API URL replaced by an
// in-memory stand-in for the GAS v10 contract (ping / login / logout / read / write with
// a session token). No credentials, real data, remote API, spreadsheet or external
// request is used, and nothing is written to disk. Restarting resets all data.
//
//   node scripts/preview-synthetic.cjs [port]      → http://127.0.0.1:<port>/
//
// The stand-in only exercises the page. It is NOT a check of the real GAS merge,
// permission or deployment behaviour.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createFixture } = require('../tests/fixtures/dashboard-fixture.cjs');

const ROOT = path.resolve(__dirname, '..');
const API_PATH = '/__test_api__';
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 512 * 1024;
const FIN_FIELDS = ['estOverride', 'actual', 'cost', 'receipts', 'estPlan', 'revMonth', 'invoiceMonth',
  'paymentMethod', 'installmentCount', 'invoices', 'costLink', 'relatedParty', 'expenses'];
const ADMIN_FIELDS = ['assignee', 'catOverride', 'deleted', 'deletedAt', 'deletedBy'];
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const clone = value => JSON.parse(JSON.stringify(value));
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

function preparePreviewHtml(html) {
  const decl = [...html.matchAll(/\bconst\s+SHEET_API_URL\s*=\s*(["'])([^"'\r\n]*)\1\s*;/g)];
  if (decl.length !== 1) throw new Error('Synthetic preview requires exactly one SHEET_API_URL declaration.');
  let out = html.replace(decl[0][0], `const SHEET_API_URL="${API_PATH}";`);
  if (/script\.google(usercontent)?\.com/i.test(out)) throw new Error('Synthetic preview refused: a production script host remains.');
  if ((out.match(/<body(?:\s[^>]*)?>/gi) || []).length !== 1) throw new Error('Synthetic preview requires one <body>.');
  const banner = `<aside data-synthetic-preview style="position:sticky;top:0;z-index:10000;background:#7f1d1d;color:#fff;padding:12px 16px;border:4px solid #fbbf24;font:15px/1.5 sans-serif;">
    <strong>離線合成測試｜127.0.0.1｜不是正式 GAS</strong><br>
    只操作本機程序記憶體，重啟即重設；所有專案、人名、金額、密碼均為虛構。<br>
    假密碼：admin <code>fake-admin</code> · finance <code>fake-finance</code> · owner <code>fake-owner</code> · member <code>fake-member</code>
  </aside>`;
  out = out.replace(/<body(?:\s[^>]*)?>/i, m => m + banner);
  // Block any cross-origin connection and any inline event attribute in the preview.
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">`;
  return out.replace(/<head>/i, m => m + csp).replace('<title>', '<title>[合成測試] ');
}

const canSeeFin = (user, row) => user.level === 'admin' || user.level === 'finance' ||
  (user.level === 'owner' && !!row && row.assignee === user.name);

function redact(state, user) {
  const out = clone(state);
  for (const [id, row] of Object.entries(out)) {
    if (!id.startsWith('_') && isObject(row) && !canSeeFin(user, state[id])) FIN_FIELDS.forEach(f => delete row[f]);
  }
  if (isObject(out._fin)) for (const id of Object.keys(out._fin)) if (!canSeeFin(user, state[id])) delete out._fin[id];
  for (const p of out._customProjects || []) if (!canSeeFin(user, state[p.id])) delete p.rev;
  return out;
}

function safeData(value, depth = 0) {
  if (depth > 30) return false;
  if (value === null || typeof value !== 'object') return true;
  return Object.entries(value).every(([k, v]) => !FORBIDDEN.has(k) && safeData(v, depth + 1));
}

// Simplified stand-in: last writer wins per row, protected fields keep the stored value.
function applyWrite(stored, incoming, user) {
  const out = clone(stored);
  for (const [id, value] of Object.entries(incoming)) {
    if (!id.startsWith('_') && isObject(value)) {
      const prev = stored[id] || {};
      const row = { ...prev, ...clone(value) };
      const keep = [...(canSeeFin(user, prev) ? [] : FIN_FIELDS), ...(user.level === 'admin' ? [] : ADMIN_FIELDS)];
      for (const f of keep) { if (Object.hasOwn(prev, f)) row[f] = clone(prev[f]); else delete row[f]; }
      out[id] = row;
    } else if (id === '_fin') {
      if (user.level === 'admin' || user.level === 'finance') out._fin = clone(value);
    } else if (id.startsWith('_')) {
      out[id] = clone(value);
    }
  }
  return out;
}

function createSyntheticApi() {
  const fixture = createFixture();
  let state = fixture.state;
  const sessions = new Map();
  const log = [];
  function handle(body) {
    log.push(body && body.action);
    if (!isObject(body) || !body.action) return { ok: false, error: 'please_reload' };
    if (body.action === 'login') {
      const user = fixture.users.find(u => u.code === String(body.code || '').trim());
      if (!user) return { ok: false, error: 'bad_code' };
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, user.name);
      return { ok: true, token, me: { name: user.name, level: user.level } };
    }
    if (body.action === 'logout') { sessions.delete(String(body.token || '')); return { ok: true }; }
    const name = sessions.get(String(body.token || ''));
    const user = name && fixture.users.find(u => u.name === name);
    if (!user) return { ok: false, error: body.token ? 'session_expired' : 'login_required' };
    const me = { name: user.name, level: user.level };
    if (body.action === 'read') return { ok: true, me, state: redact(state, user), config: clone(fixture.config) };
    if (body.action === 'write') {
      if (!isObject(body.data) || !safeData(body.data) || body.data.action !== undefined ||
          body.data.code !== undefined || body.data.token !== undefined) return { ok: false, error: 'no_data' };
      state = applyWrite(state, body.data, user);
      return { ok: true, me, state: redact(state, user) };
    }
    return { ok: false, error: 'unknown_action' };
  }
  return { handle, log, getState: () => clone(state), expire: () => sessions.clear() };
}

function createServer() {
  const html = preparePreviewHtml(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
  const api = createSyntheticApi();
  const vendor = fs.readFileSync(path.join(ROOT, 'vendor', 'xlsx.full.min.js'));
  const json = (res, obj) => { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${HOST}`);
    if (url.pathname === API_PATH && req.method === 'GET') {
      return json(res, url.searchParams.get('ping') ? { api: 4 } : { ok: false, error: 'login_required' });
    }
    if (url.pathname === API_PATH && req.method === 'POST') {
      let size = 0; const chunks = [];
      req.on('data', c => { size += c.length; if (size > MAX_BODY_BYTES) req.destroy(); else chunks.push(c); });
      req.on('end', () => { let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(res, { ok: false, error: 'bad_json' }); } json(res, api.handle(body)); });
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    }
    if (url.pathname === '/vendor/xlsx.full.min.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end(vendor);
    }
    res.writeHead(404); res.end('not found');
  });
  return { server, api };
}

if (require.main === module) {
  const port = Number(process.argv[2]) || 8787;
  const { server } = createServer();
  server.listen(port, HOST, () => console.log(`Synthetic preview: http://${HOST}:${port}/  (fake data only)`));
}

module.exports = { createServer, preparePreviewHtml, createSyntheticApi, API_PATH, HOST };
