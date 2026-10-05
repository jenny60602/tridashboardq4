'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const SOURCE_COMMIT = '876e933dcd0e25a7ba9010e2332a79109c9fdf02';
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const MAX_BLOCK_BYTES = 256 * 1024;
const EXPECTED_DECLARATIONS = [
  'PROJECTS', 'TEAM_STAFF_G1', 'TEAM_STAFF_G2', 'TEAM_STAFF',
  'TEAM_PARTNER', 'ROLES', 'TEAM',
];
const FIXED_EXPRESSIONS = {
  TEAM_STAFF: ['TEAM_STAFF_G1', '.', 'concat', '(', 'TEAM_STAFF_G2', ')'],
  TEAM: ['TEAM_STAFF', '.', 'concat', '(', 'TEAM_PARTNER', ')'],
};
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function reject(message) {
  throw new Error(message);
}

// This is deliberately a small data grammar, not a general JavaScript parser.
// The pinned source uses JSON strings, numeric months and two fixed concat calls.
function validateDeclarations(block) {
  let offset = 0;
  let tokens = 0;
  let current;
  const tokenPattern = /"(?:\\["\\/bfnrt]|\\u[0-9a-fA-F]{4}|[^"\\\u0000-\u001f])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[A-Za-z_$][A-Za-z0-9_$]*|[\[\]{}:;,=.()]/y;

  function advance() {
    while (/\s/.test(block[offset] || '') && offset < block.length) offset++;
    if (offset === block.length) {
      current = null;
      return;
    }
    tokenPattern.lastIndex = offset;
    const match = tokenPattern.exec(block);
    if (!match || ++tokens > 20000) reject('Catalog contains unsupported syntax.');
    current = match[0];
    offset = tokenPattern.lastIndex;
  }

  function take(expected) {
    if (current !== expected) reject('Catalog declarations do not match the expected structure.');
    advance();
  }

  function literal(depth = 0) {
    if (depth > 16) reject('Catalog nesting exceeds the supported limit.');
    if (current === '[') {
      advance();
      while (current !== ']') {
        literal(depth + 1);
        if (current !== ',') break;
        advance();
      }
      take(']');
    } else if (current === '{') {
      advance();
      const keys = new Set();
      while (current !== '}') {
        if (!current || !/^(?:"|[A-Za-z_$])/.test(current)) reject('Invalid catalog property.');
        const key = current.startsWith('"') ? JSON.parse(current) : current;
        if (RESERVED_KEYS.has(key) || keys.has(key)) reject('Catalog contains a forbidden or duplicate property.');
        keys.add(key);
        advance();
        take(':');
        literal(depth + 1);
        if (current !== ',') break;
        advance();
      }
      take('}');
    } else if (current && (current.startsWith('"') || /^-?\d/.test(current))) {
      advance();
    } else {
      reject('Catalog values must be data literals.');
    }
  }

  advance();
  for (const name of EXPECTED_DECLARATIONS) {
    take('const');
    take(name);
    take('=');
    if (FIXED_EXPRESSIONS[name]) {
      for (const token of FIXED_EXPRESSIONS[name]) take(token);
    } else {
      literal();
    }
    take(';');
  }
  if (current !== null) reject('Unexpected declarations after the catalog.');
}

function assertString(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) {
    reject('Catalog contains an invalid string.');
  }
}

function assertObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('Invalid catalog object.');
  if (keys && (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)))) {
    reject('Catalog object has unexpected fields.');
  }
  if (Object.keys(value).some(key => RESERVED_KEYS.has(key))) reject('Forbidden catalog field.');
}

function assertArray(value, limit = 5000) {
  if (!Array.isArray(value) || value.length > limit) reject('Invalid catalog array.');
}

function validateCatalog(catalog) {
  assertObject(catalog, ['projects', 'staffGroups', 'partners', 'roles']);
  assertArray(catalog.projects);
  if (!catalog.projects.length) reject('Catalog must include projects.');
  const ids = new Set();
  for (const project of catalog.projects) {
    assertObject(project, ['id', 'cat', 'name', 'months']);
    for (const key of ['id', 'cat', 'name']) assertString(project[key]);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(project.id) || /[\r\n]/.test(project.id)) reject('Invalid catalog project ID.');
    if (ids.has(project.id)) reject('Catalog project IDs must be unique.');
    ids.add(project.id);
    assertArray(project.months, 12);
    if (!project.months.length) reject('Catalog projects must include scheduling months.');
    if (project.months.some(month => !Number.isInteger(month) || month < 1 || month > 12)
        || new Set(project.months).size !== project.months.length) reject('Invalid catalog months.');
  }
  assertArray(catalog.staffGroups, 2);
  if (catalog.staffGroups.length !== 2) reject('Catalog must contain exactly two staff groups.');
  for (const group of [...catalog.staffGroups, catalog.partners]) {
    assertArray(group);
    group.forEach(assertString);
    if (new Set(group).size !== group.length) reject('Catalog groups must not contain duplicates.');
  }
  assertObject(catalog.roles);
  if (!catalog.staffGroups.flat().length && !catalog.partners.length) reject('Catalog must include a team.');
  if (Object.keys(catalog.roles).length > 5000) reject('Too many catalog roles.');
  for (const [name, role] of Object.entries(catalog.roles)) {
    assertString(name);
    assertString(role);
  }
  return catalog;
}

function extractCatalog(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > MAX_HTML_BYTES) reject('Invalid catalog source size.');
  const starts = [...html.matchAll(/^const PROJECTS\s*=/gm)];
  const ends = [...html.matchAll(/^const STATUSES\s*=/gm)];
  if (starts.length !== 1 || ends.length !== 1 || starts[0].index >= ends[0].index) {
    reject('The expected catalog boundaries were not found exactly once.');
  }
  const block = html.slice(starts[0].index, ends[0].index);
  if (Buffer.byteLength(block) > MAX_BLOCK_BYTES) reject('Catalog block exceeds the supported size.');
  validateDeclarations(block);

  // No host objects, functions, process, require, fetch or network APIs are exposed.
  // The strict grammar above is the primary boundary; VM restrictions are additional.
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  });
  let catalog;
  try {
    const result = vm.runInContext(`${block}\n({projects:PROJECTS,staffGroups:[TEAM_STAFF_G1,TEAM_STAFF_G2],partners:TEAM_PARTNER,roles:ROLES})`, context, {
      timeout: 100,
      displayErrors: false,
    });
    catalog = JSON.parse(JSON.stringify(result));
  } catch {
    reject('Catalog data could not be evaluated safely.');
  }
  return validateCatalog(catalog);
}

function readCatalogFromGit(repoDir) {
  let html;
  try {
    html = execFileSync('git', ['show', `${SOURCE_COMMIT}:index.html`], {
      cwd: repoDir,
      encoding: 'utf8',
      maxBuffer: MAX_HTML_BYTES,
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch {
    reject('Could not read the pinned catalog commit from the local Git repository.');
  }
  return extractCatalog(html);
}

function writePrivateCatalog(repoDir, catalog) {
  validateCatalog(catalog);
  const directory = path.join(path.resolve(repoDir), '.private');
  const output = path.join(directory, 'Catalog.gs');
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') reject('Could not create the private catalog directory.');
  }
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) reject('The private catalog directory must be a regular directory.');
  try {
    fs.writeFileSync(output, `const DASHBOARD_CATALOG = ${JSON.stringify(catalog, null, 2)};\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (error.code === 'EEXIST') reject('Catalog.gs already exists. Review and preserve it manually before deciding whether to regenerate; no file was overwritten.');
    reject('Could not create the private catalog file.');
  }
  return output;
}

function main() {
  if (process.argv.length !== 2) reject('Usage: node scripts/prepare-catalog.cjs (no options; no overwrite mode).');
  const repoDir = path.resolve(__dirname, '..');
  const catalog = readCatalogFromGit(repoDir);
  const output = writePrivateCatalog(repoDir, catalog);
  console.log(JSON.stringify({
    path: output,
    projects: catalog.projects.length,
    staffGroups: catalog.staffGroups.map(group => group.length),
    partners: catalog.partners.length,
    roles: Object.keys(catalog.roles).length,
  }));
}

module.exports = { SOURCE_COMMIT, extractCatalog, validateCatalog, readCatalogFromGit, writePrivateCatalog };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    // Errors from source parsing are fixed descriptions, never source snippets.
    console.error(error.message);
    process.exitCode = 1;
  }
}
