/**
 * Replace the existing doGet/doPost entry points with this file.
 * Keep the existing json_, lookupUser_, readState_, isRowKey_, mergeState,
 * mergeWrite_, redact_, and writeState_ implementations unchanged.
 *
 * The deployment must also define DASHBOARD_CATALOG in a private Catalog.gs.
 * Do not commit the company's catalog or financial seed data to this repository.
 */
function doGet(e) {
  if (e && e.parameter && e.parameter.ping) {
    return json_({ api: 4, authRequired: true });
  }
  return json_({ ok: false, error: 'login_required' });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'bad_json' });
  }
  if (!dashboardPlainObject_(body)) {
    return json_({ ok: false, error: 'bad_request' });
  }
  if (body.action !== 'read' && body.action !== 'write') {
    return json_({ ok: false, error: 'unknown_action' });
  }
  if (body.code === undefined || body.code === null ||
      (typeof body.code === 'string' && !body.code.trim())) {
    return json_({ ok: false, error: 'login_required' });
  }
  if (typeof body.code !== 'string') {
    return json_({ ok: false, error: 'bad_code' });
  }

  var me;
  try {
    me = lookupUser_(body.code.trim());
  } catch (err) {
    return json_({ ok: false, error: 'bad_code' });
  }
  if (!me || me.error) {
    return json_({ ok: false, error: 'bad_code' });
  }

  if (body.action === 'write') {
    if (!dashboardPlainObject_(body.data)) {
      return json_({ ok: false, error: 'no_data' });
    }
    if (body.base !== undefined && !dashboardPlainObject_(body.base)) {
      return json_({ ok: false, error: 'bad_base' });
    }
  }

  var catalog;
  try {
    catalog = dashboardCatalog_();
  } catch (err) {
    return json_({ ok: false, error: 'catalog_not_configured' });
  }

  if (body.action === 'read') {
    return json_({
      ok: true,
      me: me,
      state: redact_(readState_(), me),
      catalog: catalog
    });
  }

  // Preserve the existing write lock, data-loss guard, merge and finance policy.
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var stored = readState_();
    var cnt = function(st) {
      return Object.keys(st).filter(function(k) {
        return isRowKey_(k, st[k]);
      }).length;
    };
    if (body.data.action !== undefined || body.data.code !== undefined ||
        (cnt(stored) >= 10 && cnt(body.data) < cnt(stored) * 0.5) ||
        ((stored._customProjects || []).length >= 3 &&
         !(body.data._customProjects || []).length)) {
      return json_({ ok: false, error: 'rejected_suspicious_write' });
    }

    var merged;
    if (body.base) {
      var merged0 = mergeState(body.base, body.data, stored);
      merged = mergeWrite_(stored, merged0, me);
    } else {
      merged = mergeWrite_(stored, body.data, me);
    }
    writeState_(merged);
    return json_({ ok: true, me: me, state: redact_(merged, me) });
  } finally {
    lock.releaseLock();
  }
}

function dashboardPlainObject_(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  var proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function dashboardCatalog_() {
  var fail = function() { throw new Error('catalog_not_configured'); };
  var name = function(value) {
    if (typeof value !== 'string' || !value.trim()) fail();
    return value;
  };
  var names = function(values) {
    if (!Array.isArray(values)) fail();
    return Array.from(values).map(name);
  };
  if (typeof DASHBOARD_CATALOG === 'undefined' ||
      !dashboardPlainObject_(DASHBOARD_CATALOG)) fail();
  var source = DASHBOARD_CATALOG;
  if (!Array.isArray(source.projects) || !source.projects.length ||
      !Array.isArray(source.staffGroups) || source.staffGroups.length !== 2 ||
      !dashboardPlainObject_(source.roles)) fail();

  var ids = Object.create(null);
  var projects = Array.from(source.projects).map(function(project) {
    if (!dashboardPlainObject_(project) || typeof project.id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(project.id) ||
        /[\r\n]/.test(project.id) || ids[project.id] ||
        !Array.isArray(project.months) || !project.months.length) fail();
    ids[project.id] = true;
    var months = Array.from(project.months).map(function(month) {
      if (typeof month !== 'number' || !isFinite(month) ||
          Math.floor(month) !== month || month < 1 || month > 12) fail();
      return month;
    });
    // Pick only catalog fields; never return financial or other extra fields.
    return {
      id: project.id,
      cat: name(project.cat),
      name: name(project.name),
      months: months
    };
  });
  var staffGroups = Array.from(source.staffGroups).map(names);
  var partners = names(source.partners);
  if (!staffGroups[0].length && !staffGroups[1].length && !partners.length) fail();
  var roles = Object.create(null);
  Object.keys(source.roles).forEach(function(person) {
    roles[name(person)] = name(source.roles[person]);
  });
  return { projects: projects, staffGroups: staffGroups, partners: partners, roles: roles };
}
