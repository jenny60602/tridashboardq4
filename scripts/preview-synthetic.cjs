'use strict';

// Local synthetic preview only: no credentials, historical catalog, remote API,
// spreadsheet, external requests or filesystem writes are used by this server.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createFixture } = require('../tests/fixtures/dashboard-fixture.cjs');

const ROOT = path.resolve(__dirname, '..');
const API_PATH = '/__test_api__';
const MAX_BODY_BYTES = 512 * 1024;
const FINANCE_FIELDS = ['estOverride', 'actual', 'cost', 'receipts', 'estPlan', 'revMonth',
  'invoiceMonth', 'paymentMethod', 'installmentCount', 'invoices', 'relatedParty', 'costLink'];
const ADMIN_FIELDS = ['assignee', 'catOverride', 'deleted', 'deletedAt', 'deletedBy'];
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const clone = value => JSON.parse(JSON.stringify(value));
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);

function preparePreviewHtml(html) {
  const declarations = [...html.matchAll(/\bconst\s+SHEET_API_URL\s*=\s*(["'])([^"'\r\n]*)\1\s*;/g)];
  if (declarations.length !== 1) throw new Error('Synthetic preview requires exactly one API URL declaration.');
  let result = html.replace(declarations[0][0], `const SHEET_API_URL="${API_PATH}";`);
  if (/script\.google\.com/i.test(result)) throw new Error('Synthetic preview refused: a production script host remains.');
  if ((result.match(/<body(?:\s[^>]*)?>/gi) || []).length !== 1) throw new Error('Synthetic preview requires one body element.');
  const banner = `<aside data-synthetic-preview style="position:sticky;top:0;z-index:10000;background:#7f1d1d;color:white;padding:14px 18px;border:4px solid #fbbf24;font:16px/1.5 sans-serif;">
    <strong>離線合成測試｜127.0.0.1｜不是正式 GAS</strong><br>
    只操作本機程序記憶體；重啟即重設。全部專案、人名、金額及密碼均為虛構。<br>
    假密碼：admin <code>fake-admin</code> · finance <code>fake-finance</code> · owner <code>fake-owner</code> · member <code>fake-member</code><br>
    此 API 只供畫面測試，不代表正式 GAS 的合併、權限或部署驗證。
  </aside>`;
  result = result.replace(/<body(?:\s[^>]*)?>/i, match => match + banner);
  return result.replace('<title>', '<title>[合成測試] ');
}

function hasFinancialAccess(user, row) {
  return user.level === 'admin' || user.level === 'finance' ||
    (user.level === 'owner' && row?.assignee === user.name);
}

function redactSynthetic(state, user) {
  const result = clone(state);
  for (const [id, row] of Object.entries(result)) {
    if (!id.startsWith('_') && object(row) && !hasFinancialAccess(user, state[id])) {
      for (const field of FINANCE_FIELDS) delete row[field];
    }
  }
  if (object(result._fin)) {
    for (const id of Object.keys(result._fin)) {
      if (!hasFinancialAccess(user, state[id])) delete result._fin[id];
    }
    if (!Object.keys(result._fin).length) delete result._fin;
  }
  for (const project of result._customProjects || []) {
    if (!hasFinancialAccess(user, state[project.id])) delete project.rev;
  }
  return result;
}

function safeData(value, depth = 0) {
  if (depth > 30) return false;
  if (value === null || typeof value !== 'object') return true;
  return Object.entries(value).every(([key, child]) => !FORBIDDEN.has(key) && safeData(child, depth + 1));
}

function mergeSynthetic(state, incoming, user) {
  if (!object(incoming) || !safeData(incoming) || incoming.action !== undefined || incoming.code !== undefined) {
    throw new Error('invalid_synthetic_data');
  }
  const result = clone(state);
  for (const [id, value] of Object.entries(incoming)) {
    if (!id.startsWith('_') && object(value)) {
      const previous = result[id] || {};
      const row = { ...previous, ...clone(value) };
      const protectedFields = [
        ...(!hasFinancialAccess(user, previous) ? FINANCE_FIELDS : []),
        ...(user.level !== 'admin' ? ADMIN_FIELDS : []),
      ];
      for (const field of protectedFields) {
        if (Object.hasOwn(previous, field)) row[field] = clone(previous[field]);
        else delete row[field];
      }
      result[id] = row;
    } else if (id === '_fin') {
      if (user.level === 'admin' || user.level === 'finance') result[id] = clone(value);
    } else if (id === '_customProjects' && Array.isArray(value)) {
      result[id] = value.map(project => {
        const item = clone(project);
        if (!hasFinancialAccess(user, result[item.id])) {
          const previous = (state[id] || []).find(old => old.id === item.id);
          if (previous && Object.hasOwn(previous, 'rev')) item.rev = previous.rev;
          else delete item.rev;
        }
        return item;
      });
    } else if (id.startsWith('_')) {
      result[id] = clone(value);
    }
  }
  return result;
}

function createSyntheticApi() {
  const fixture = createFixture();
  let state = fixture.state;
  return function request(payload) {
    if (!object(payload)) return { ok: false, error: 'invalid_request', synthetic: true };
    const user = fixture.users.find(candidate => candidate.code === payload.code);
    if (!user) return { ok: false, error: payload.code ? 'bad_code' : 'login_required', synthetic: true };
    if (!['read', 'write'].includes(payload.action)) return { ok: false, error: 'invalid_request', synthetic: true };
    if (payload.action === 'write') {
      try { state = mergeSynthetic(state, payload.data, user); }
      catch { return { ok: false, error: 'invalid_synthetic_data', synthetic: true }; }
    }
    return {
      ok: true, synthetic: true, me: { name: user.name, level: user.level },
      state: redactSynthetic(state, user), catalog: clone(fixture.catalog),
    };
  };
}

function send(response, status, contentType, body) {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Synthetic-Preview': 'true',
    'Content-Security-Policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; script-src-attr 'none'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'",
  });
  response.end(body);
}

function createPreviewHandler({ html, vendor } = {}) {
  // The only filesystem reads are these two fixed, public application files.
  const page = preparePreviewHtml(html ?? fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
  const xlsx = vendor ?? fs.readFileSync(path.join(ROOT, 'vendor', 'xlsx.full.min.js'));
  const api = createSyntheticApi();
  return async function handle(request, response) {
    const host = request.headers.host || '';
    if (!/^127\.0\.0\.1(?::\d{1,5})?$/.test(host) ||
        (request.headers.origin && request.headers.origin !== `http://${host}`)) {
      send(response, 403, 'text/plain; charset=utf-8', 'Synthetic preview accepts loopback same-origin requests only.');
      return;
    }
    if (request.method === 'GET' && request.url === '/') {
      send(response, 200, 'text/html; charset=utf-8', page);
    } else if (request.method === 'GET' && request.url === '/vendor/xlsx.full.min.js') {
      send(response, 200, 'text/javascript; charset=utf-8', xlsx);
    } else if (request.method === 'GET' && request.url === `${API_PATH}?ping=1`) {
      send(response, 200, 'application/json; charset=utf-8', JSON.stringify({ api: 4, authRequired: true, synthetic: true }));
    } else if (request.method === 'POST' && request.url === API_PATH) {
      try {
        let bytes = 0;
        const chunks = [];
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > MAX_BODY_BYTES) {
            send(response, 413, 'text/plain; charset=utf-8', 'Synthetic request is too large.');
            return;
          }
          chunks.push(Buffer.from(chunk));
        }
        const result = api(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        send(response, 200, 'application/json; charset=utf-8', JSON.stringify(result));
      } catch {
        send(response, 400, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: 'invalid_request', synthetic: true }));
      }
    } else {
      send(response, 404, 'text/plain; charset=utf-8', 'Synthetic preview route not found.');
    }
  };
}

function createSyntheticServer(options = {}) {
  return http.createServer(createPreviewHandler(options));
}

function startPreview({ port = 4173 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid local preview port.');
  const server = createSyntheticServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/` });
    });
  });
}

module.exports = { preparePreviewHtml, createSyntheticApi, createPreviewHandler, createSyntheticServer, startPreview, listen: startPreview };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && !/^--port=\d+$/.test(args[0]))) {
    console.error('Usage: node scripts/preview-synthetic.cjs [--port=4173]');
    process.exitCode = 1;
  } else {
    const port = args.length ? Number(args[0].slice('--port='.length)) : 4173;
    Promise.resolve().then(() => startPreview({ port })).then(({ server, url }) => {
      console.log(`Synthetic preview only: ${url}`);
      console.log('All data and passwords are invented. Writes stay in process memory; restart resets them.');
      console.log('Fake passwords: fake-admin | fake-finance | fake-owner | fake-member');
      process.once('SIGINT', () => server.close());
      process.once('SIGTERM', () => server.close());
    }).catch(() => {
      console.error('Could not start the synthetic preview. Check the local port and endpoint-isolation guard.');
      process.exitCode = 1;
    });
  }
}
