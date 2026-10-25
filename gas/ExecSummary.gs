/**
 * 經營檢視（主管限定）— 財務摘要讀取模組
 *
 * 這個檔案只有程式，沒有任何名單、試算表 ID 或財務數字。正式啟用前由 GAS 擁有者：
 *   1. 建立一份「獨立」的財務摘要試算表（不要放在儀表板試算表裡），只分享給必要的人。
 *      分頁「財務摘要」第一列貼上 templates/finance-summary.template.csv 的表頭；
 *      分頁「週會決策紀錄」第一列貼上 templates/decision-log.template.csv 的表頭（可先留空）；
 *      另建空白分頁「存取紀錄」。
 *   2. 專案設定 → 指令碼屬性：
 *        EXEC_VIEWERS  = ["<權限分頁 A 欄的確切名稱>", "<…>"]   （JSON 陣列，名稱須與權限分頁完全一致）
 *        EXEC_SHEET_ID = <上述財務摘要試算表的 ID>
 *      兩者沒設定時一律拒絕（fail closed）。
 *   3. 在現有 doPost 的「const me = sessionUser_(body.token); if (!me) …」之後加一行：
 *        if (body.action === 'execRead') return execRead_(me);
 *   4. 先用測試部署驗證，再更新正式部署。
 *
 * 權限只在這裡判斷：每次請求都用通行證重新查「權限」分頁取得姓名（sessionUser_），
 * 再比對 EXEC_VIEWERS。與「管理者／財務」等級無關——等級再高，不在名單內也看不到。
 * 財務摘要不會出現在 read／write 的回應或 State 分頁裡。
 */

var EXEC_SHEET_NAME = '財務摘要';
var EXEC_LOG_SHEET_NAME = '存取紀錄';
var EXEC_HEADERS = ['會計年度', '截至月份', '指標代碼', '指標名稱', '期間', '預算金額', '實際金額',
  '資料來源', '資料版本', '更新日期', '確認人', '是否已結帳', '備註'];
var EXEC_METRICS = { revenue: '營收', net_income: '稅後淨利' };
var EXEC_PERIODS = { annual: '年度', month: '當月', ytd: '年初至今累計' };
var EXEC_MAX_ROWS = 500;
var EXEC_DECISION_SHEET_NAME = '週會決策紀錄';
var EXEC_DECISION_HEADERS = ['討論日期', '議題', '相關專案／業務', '待決策問題', '決策結果', '負責人', '完成期限', '追蹤狀態'];
var EXEC_DECISION_STATUSES = ['待決策', '已決策', '執行中', '已完成', '暫緩'];

function execViewers_() {
  var raw = PropertiesService.getScriptProperties().getProperty('EXEC_VIEWERS');
  return execParseViewers_(raw);
}

/** 純函式：解析白名單設定；格式不對就當作空名單。 */
function execParseViewers_(raw) {
  try {
    var v = JSON.parse(raw || '[]');
    if (!Array.isArray(v)) return [];
    var out = [];
    v.forEach(function (x) {
      if (typeof x === 'string' && x.trim() && out.indexOf(x.trim()) < 0) out.push(x.trim());
    });
    return out;
  } catch (e) {
    return [];
  }
}

/** 純函式：me 是伺服器查到的身分（sessionUser_ 的結果），不是前端送來的。 */
function execCanView_(me, viewers) {
  return !!me && !me.error && typeof me.name === 'string' && viewers.indexOf(me.name) >= 0;
}

function execNum_(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  return isFinite(n) ? Math.round(n * 100) / 100 : undefined;
}
function execText_(v, max) {
  return String(v === null || v === undefined ? '' : v).trim().slice(0, max || 200)
    .replace(/</g, '＜').replace(/>/g, '＞');
}
function execDate_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) {
    var y = v.getFullYear(), m = ('0' + (v.getMonth() + 1)).slice(-2), d = ('0' + v.getDate()).slice(-2);
    return y + '-' + m + '-' + d;
  }
  var s = String(v || '').trim().replace(/\//g, '-');
  var mm = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!mm) return null;
  return mm[1] + '-' + ('0' + mm[2]).slice(-2) + '-' + ('0' + mm[3]).slice(-2);
}
function execBool_(v) {
  if (v === true || v === false) return v;
  var s = String(v || '').trim().toLowerCase();
  if (['是', 'y', 'yes', 'true', '1', '已結帳'].indexOf(s) >= 0) return true;
  if (['否', 'n', 'no', 'false', '0', '', '未結帳'].indexOf(s) >= 0) return false;
  return null;
}

/**
 * 純函式：把試算表的列（含表頭）轉成乾淨的資料。
 * 表頭不符就整份拒絕；個別列不合格就略過並計數，不猜測、不補值。
 */
function execParseRows_(values) {
  if (!Array.isArray(values) || !values.length) return { rows: [], invalid: 0, headerOk: false };
  var header = values[0].map(function (h) { return String(h || '').trim(); });
  var headerOk = EXEC_HEADERS.every(function (h, i) { return header[i] === h; });
  if (!headerOk) return { rows: [], invalid: 0, headerOk: false };
  var rows = [], invalid = 0;
  values.slice(1, EXEC_MAX_ROWS + 1).forEach(function (r) {
    if (!r || r.every(function (c) { return c === '' || c === null || c === undefined; })) return;
    var year = execNum_(r[0]), month = execNum_(r[1]);
    var metric = String(r[2] || '').trim(), period = String(r[4] || '').trim();
    var budget = execNum_(r[5]), actual = execNum_(r[6]);
    var updatedAt = execDate_(r[9]), closed = execBool_(r[11]);
    var ok = year !== null && year !== undefined && Math.floor(year) === year && year >= 2000 && year <= 2100 &&
      month !== null && month !== undefined && Math.floor(month) === month && month >= 1 && month <= 12 &&
      Object.prototype.hasOwnProperty.call(EXEC_METRICS, metric) &&
      Object.prototype.hasOwnProperty.call(EXEC_PERIODS, period) &&
      budget !== undefined && actual !== undefined && (budget !== null || actual !== null) &&
      updatedAt !== null && closed !== null && execText_(r[7]) !== '' && execText_(r[8]) !== '';
    if (!ok) { invalid++; return; }
    rows.push({
      fiscalYear: year, asOfMonth: month, metric: metric, metricName: execText_(r[3], 50) || EXEC_METRICS[metric],
      period: period, budget: budget, actual: actual, source: execText_(r[7], 200), version: execText_(r[8], 100),
      updatedAt: updatedAt, confirmedBy: execText_(r[10], 50), closed: closed, note: execText_(r[12], 300)
    });
  });
  return { rows: rows, invalid: invalid, headerOk: true };
}

/** 純函式：週會決策紀錄。表頭不符整份拒絕；日期、狀態不合格的列略過並計數。 */
function execParseDecisions_(values) {
  if (!Array.isArray(values) || !values.length) return { rows: [], invalid: 0, headerOk: false };
  var header = values[0].map(function (h) { return String(h || '').trim(); });
  var headerOk = EXEC_DECISION_HEADERS.every(function (h, i) { return header[i] === h; });
  if (!headerOk) return { rows: [], invalid: 0, headerOk: false };
  var rows = [], invalid = 0;
  values.slice(1, EXEC_MAX_ROWS + 1).forEach(function (r) {
    if (!r || r.every(function (c) { return c === '' || c === null || c === undefined; })) return;
    var date = execDate_(r[0]), due = r[6] === '' || r[6] === null || r[6] === undefined ? '' : execDate_(r[6]);
    var status = String(r[7] || '').trim(), topic = execText_(r[1], 200);
    if (!date || due === null || EXEC_DECISION_STATUSES.indexOf(status) < 0 || !topic) { invalid++; return; }
    rows.push({ date: date, topic: topic, related: execText_(r[2], 200), question: execText_(r[3], 1000),
      decision: execText_(r[4], 1000), owner: execText_(r[5], 50), due: due, status: status });
  });
  return { rows: rows, invalid: invalid, headerOk: true };
}

function execLog_(me, result) {
  try {
    var id = PropertiesService.getScriptProperties().getProperty('EXEC_SHEET_ID');
    if (!id) return;
    var sh = SpreadsheetApp.openById(id).getSheetByName(EXEC_LOG_SHEET_NAME);
    if (sh) sh.appendRow([new Date(), (me && me.name) || '', 'execRead', result]);
  } catch (e) { /* 紀錄失敗不影響回應 */ }
}

function execRead_(me) {
  if (!execCanView_(me, execViewers_())) {
    execLog_(me, 'denied');
    return json_({ ok: false, error: 'forbidden' });
  }
  var id = PropertiesService.getScriptProperties().getProperty('EXEC_SHEET_ID');
  // 財務摘要必須是另一份試算表，不能和所有人共用的儀表板資料放在一起。
  if (!id || id === SpreadsheetApp.getActiveSpreadsheet().getId()) {
    return json_({ ok: false, error: 'exec_not_configured' });
  }
  var sh;
  try { sh = SpreadsheetApp.openById(id).getSheetByName(EXEC_SHEET_NAME); } catch (e) { sh = null; }
  if (!sh) return json_({ ok: false, error: 'exec_not_configured' });
  var parsed = execParseRows_(sh.getDataRange().getValues());
  if (!parsed.headerOk) return json_({ ok: false, error: 'exec_bad_header' });
  var dsh = SpreadsheetApp.openById(id).getSheetByName(EXEC_DECISION_SHEET_NAME);
  var decisions = dsh ? execParseDecisions_(dsh.getDataRange().getValues()) : null;
  execLog_(me, 'ok');
  return json_({ ok: true, me: me, exec: {
    rows: parsed.rows, invalidRows: parsed.invalid,
    decisions: decisions && decisions.headerOk ? decisions.rows : [],
    decisionsStatus: !decisions ? 'missing' : (decisions.headerOk ? 'ok' : 'bad_header'),
    invalidDecisions: decisions ? decisions.invalid : 0,
    readAt: new Date().toISOString() } });
}
