/**
 * 機會評估分數卡 — 權限與合併模組
 *
 * 資料存在 State 的 _opp：{ <專案id>: { scores: { <姓名>: {fin,value,impact,capacity,certainty,note,at} },
 *                                       decision: {result,reason,by,at} | null } }
 *
 * 這個檔案只有程式，沒有名單。正式啟用前由 GAS 擁有者：
 *   1. 專案設定 → 指令碼屬性：OPP_SCORERS = ["<權限分頁 A 欄的確切名稱>", …]（JSON 陣列）
 *      管理者一律可以評分；其他人要在名單內。沒設定 = 只有管理者（fail closed）。
 *   2. 主程式加四個接點（見 docs/opportunity-scorecard.md）：
 *      redact_ 呼叫 oppRedact_、mergeWrite_ 呼叫 oppMerge_、ADMIN_FIELDS 加 bizLine、cleanField_ 加 bizLine。
 *
 * 規則（全部在後端判斷）：
 *   - 不在名單的人：讀取時看不到 _opp，寫入時送來的 _opp 一律忽略。
 *   - 每個人只能新增／修改／撤回「自己的」分數；姓名來自伺服器端通行證，不能冒名。
 *   - 只有管理者能記錄或清除「決定」（接／不接／先驗證）。
 *   - 只接受已知專案的 id。
 */

var OPP_DIMS = ['fin', 'value', 'impact', 'capacity', 'certainty'];
var OPP_RESULTS = ['接', '不接', '先驗證'];
var OPP_SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
var BIZ_LINES = ['企業與通路', '零售與消費者', '專案與公共服務', '專案與公共服務・市集'];

function oppScorers_() {
  return oppParseScorers_(PropertiesService.getScriptProperties().getProperty('OPP_SCORERS'));
}

/** 純函式：解析評分名單；格式不對就當作空名單。 */
function oppParseScorers_(raw) {
  try {
    var arr = JSON.parse(raw || '[]');
    if (!Array.isArray(arr)) return [];
    return arr.map(function (x) { return String(x || '').trim(); }).filter(function (x) { return x; });
  } catch (e) { return []; }
}

/** 純函式：這個人能不能看／評分。 */
function oppCanScore_(me, scorers) {
  if (!me || me.error || !me.name) return false;
  if (me.level === 'admin') return true;
  return (scorers || []).indexOf(me.name) >= 0;
}

function oppStr_(v, max) {
  return String(v === null || v === undefined ? '' : v).replace(/</g, '＜').replace(/>/g, '＞').slice(0, max);
}
function oppIsObj_(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

/** 純函式：檢查一筆分數；不合格回 null。 */
function oppCleanScore_(s) {
  if (!oppIsObj_(s)) return null;
  var out = {};
  for (var i = 0; i < OPP_DIMS.length; i++) {
    var n = Number(s[OPP_DIMS[i]]);
    if (!(n >= 1 && n <= 5 && Math.floor(n) === n)) return null;
    out[OPP_DIMS[i]] = n;
  }
  out.note = oppStr_(s.note, 300);
  return out;
}

/** 純函式：檢查一筆決定；不合格回 undefined，清除回 null。 */
function oppCleanDecision_(d) {
  if (d === null) return null;
  if (!oppIsObj_(d) || OPP_RESULTS.indexOf(d.result) < 0) return undefined;
  return { result: d.result, reason: oppStr_(d.reason, 500) };
}

function oppSameScore_(a, b) {
  if (!a || !b) return false;
  for (var i = 0; i < OPP_DIMS.length; i++) if (a[OPP_DIMS[i]] !== b[OPP_DIMS[i]]) return false;
  return (a.note || '') === (b.note || '');
}

/** 讀取時呼叫：不在名單的人拿不到 _opp；名單內的人一定拿到物件（可能是空的）。 */
function oppRedact_(out, stored, me, scorers) {
  if (scorers === undefined) scorers = oppScorers_();
  if (oppCanScore_(me, scorers)) out._opp = oppIsObj_(stored._opp) ? stored._opp : {};
  else delete out._opp;
  return out;
}

/**
 * 純函式：合併寫入。stored/incoming 是 _opp 物件，knownIds 是 {id:1}，now 是時間戳。
 * 回傳新的 _opp（沒權限時原樣回傳 stored）。
 */
function oppMerge_(stored, incoming, me, knownIds, scorers, now) {
  var base = oppIsObj_(stored) ? stored : {};
  if (!oppCanScore_(me, scorers) || !oppIsObj_(incoming)) return base;
  var isAdmin = me.level === 'admin';
  var out = {};
  Object.keys(base).forEach(function (pid) { out[pid] = base[pid]; });
  var ids = {};
  Object.keys(base).forEach(function (pid) { ids[pid] = 1; });
  Object.keys(incoming).forEach(function (pid) { ids[pid] = 1; });
  Object.keys(ids).forEach(function (pid) {
    if (!OPP_SAFE_ID.test(pid) || !knownIds[pid]) return;
    var old = oppIsObj_(base[pid]) ? base[pid] : { scores: {}, decision: null };
    var oldScores = oppIsObj_(old.scores) ? old.scores : {};
    var inc = oppIsObj_(incoming[pid]) ? incoming[pid] : null;
    var scores = {};
    Object.keys(oldScores).forEach(function (n) { scores[n] = oldScores[n]; });
    var changed = false;
    if (inc) {
      // 只看自己的那一筆：新增、修改或撤回
      var incScores = oppIsObj_(inc.scores) ? inc.scores : {};
      if (Object.prototype.hasOwnProperty.call(incScores, me.name)) {
        var c = oppCleanScore_(incScores[me.name]);
        if (c && !oppSameScore_(c, oldScores[me.name])) { c.at = now; scores[me.name] = c; changed = true; }
      } else if (oldScores[me.name] && oppIsObj_(inc.scores)) {
        delete scores[me.name]; changed = true;
      }
    }
    var decision = old.decision || null;
    if (inc && isAdmin && 'decision' in inc) {
      var d = oppCleanDecision_(inc.decision);
      if (d === null && decision) { decision = null; changed = true; }
      else if (d && (!decision || decision.result !== d.result || decision.reason !== d.reason)) {
        decision = { result: d.result, reason: d.reason, by: me.name, at: now }; changed = true;
      }
    }
    if (!changed) return;
    if (!Object.keys(scores).length && !decision) delete out[pid];
    else out[pid] = { scores: scores, decision: decision };
  });
  return out;
}

/** 管理者設定的業務線（null = 依專案分類自動推得）。 */
function cleanBizLine_(v) {
  if (v === null || v === undefined || v === '') return null;
  return BIZ_LINES.indexOf(v) >= 0 ? v : undefined;
}
