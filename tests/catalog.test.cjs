'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { extractCatalog, validateCatalog, writePrivateCatalog } = require('../scripts/prepare-catalog.cjs');

// Entirely synthetic data. Never copy the company's real catalog into fixtures.
function fixture(projects = '[{id:"demo-1",cat:"Example",name:"Synthetic project",months:[10,11]}]') {
  return `<!doctype html><script>throw new Error("outside catalog must not run");</script>
const PROJECTS=${projects};
const TEAM_STAFF_G1=["Person A"];
const TEAM_STAFF_G2=["Person B"];
const TEAM_STAFF=TEAM_STAFF_G1.concat(TEAM_STAFF_G2);
const TEAM_PARTNER=["Partner C"];
const ROLES={"Person A":"Example role"};
const TEAM=TEAM_STAFF.concat(TEAM_PARTNER);
const STATUSES=["Example status"];
throw new Error("rest of HTML must not run");`;
}

test('extracts only the approved data block with the required output schema', () => {
  assert.deepEqual(extractCatalog(fixture()), {
    projects: [{ id: 'demo-1', cat: 'Example', name: 'Synthetic project', months: [10, 11] }],
    staffGroups: [['Person A'], ['Person B']],
    partners: ['Partner C'],
    roles: { 'Person A': 'Example role' },
  });
});

test('requires unique ordered source boundaries', () => {
  assert.throws(() => extractCatalog(fixture().replace('const PROJECTS=', 'const OTHER=')));
  assert.throws(() => extractCatalog(fixture() + '\nconst PROJECTS=[];'));
  assert.throws(() => extractCatalog('const STATUSES=[];\nconst PROJECTS=[];'));
});

test('rejects extra declarations, statements and altered derived expressions', () => {
  for (const insertion of ['const EXTRA=[];', 'while(true){}', 'process.exit();']) {
    assert.throws(() => extractCatalog(fixture().replace('const ROLES=', `${insertion}\nconst ROLES=`)));
  }
  assert.throws(() => extractCatalog(fixture().replace('TEAM_STAFF_G1.concat(TEAM_STAFF_G2)', 'TEAM_STAFF_G1.map(Function)')));
  assert.throws(() => extractCatalog(fixture().replace('const TEAM=', 'let TEAM=')));
});

test('rejects executable values and access to host or generated code', () => {
  for (const expression of ['process.env', 'require("node:fs")', 'fetch("https://invalid.example")',
    'Function("return 1")()', '(()=>[])()', '`template`', '[...[]]', 'new Array(1)']) {
    assert.throws(() => extractCatalog(fixture(expression)));
  }
});

test('rejects unexpected project fields, duplicate IDs and invalid months', () => {
  for (const projects of [
    '[]',
    '[{id:"p",cat:"x",name:"n",months:[]}]',
    '[{id:"bad id",cat:"x",name:"n",months:[10]}]',
    '[{id:"p",cat:"x",name:"n",months:[13]}]',
    '[{id:"p",cat:"x",name:"n",months:[1,1]}]',
    '[{id:"p",cat:"x",name:"n",months:[1.5]}]',
    '[{id:"p",cat:"x",name:"n",months:[],rev:99}]',
    '[{id:"p",cat:"x",name:"n",months:[]},{id:"p",cat:"x",name:"n",months:[]}]',
    '[{id:"p",cat:"x",name:"",months:[]}]',
  ]) assert.throws(() => extractCatalog(fixture(projects)));
});

test('rejects duplicate and prototype-related keys, including escaped keys', () => {
  for (const roleLiteral of ['{"x":"a","x":"b"}', '{"__proto__":"x"}',
    '{"\\u005f_proto__":"x"}', '{constructor:"x"}', '{prototype:"x"}']) {
    assert.throws(() => extractCatalog(fixture().replace('{"Person A":"Example role"}', roleLiteral)));
  }
});

test('validates staff groups, partners, roles and exact catalog shape', () => {
  for (const alter of [
    c => { c.staffGroups = [[]]; },
    c => { c.partners = [123]; },
    c => { c.roles = { x: {} }; },
    c => { c.staffGroups[0] = ['duplicate', 'duplicate']; },
    c => { c.extra = []; },
    c => { c.staffGroups = [[], []]; c.partners = []; },
  ]) {
    const catalog = extractCatalog(fixture());
    alter(catalog);
    assert.throws(() => validateCatalog(catalog));
  }
});

test('bounds source size and nesting before evaluation', () => {
  assert.throws(() => extractCatalog(' '.repeat(4 * 1024 * 1024 + 1)));
  assert.throws(() => extractCatalog(fixture('['.repeat(20) + '1' + ']'.repeat(20))));
});

test('writes only the private GAS constant and refuses to overwrite', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-catalog-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const catalog = extractCatalog(fixture());
  const output = writePrivateCatalog(directory, catalog);
  assert.equal(output, path.join(directory, '.private', 'Catalog.gs'));
  const first = fs.readFileSync(output, 'utf8');
  assert.deepEqual(JSON.parse(vm.runInNewContext(first + '\nJSON.stringify(DASHBOARD_CATALOG)', {}, { timeout: 100 })), catalog);
  assert.equal(first, `const DASHBOARD_CATALOG = ${JSON.stringify(catalog, null, 2)};\n`);
  catalog.projects[0].name = 'Changed synthetic value';
  assert.throws(() => writePrivateCatalog(directory, catalog), /already exists/);
  assert.equal(fs.readFileSync(output, 'utf8'), first);
  assert.deepEqual(fs.readdirSync(directory), ['.private']);
});

test('an existing private directory placeholder is not replaced', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-catalog-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, '.private'), 'synthetic sentinel');
  assert.throws(() => writePrivateCatalog(directory, extractCatalog(fixture())), /regular directory/);
  assert.equal(fs.readFileSync(path.join(directory, '.private'), 'utf8'), 'synthetic sentinel');
});
