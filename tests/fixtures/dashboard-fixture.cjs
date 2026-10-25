'use strict';

// Invented test data only. Names, projects, amounts and passwords have no
// connection to any real person, client or account.
const USERS = [
  { name: 'Synthetic Admin', level: 'admin', code: 'fake-admin' },
  { name: 'Synthetic Finance', level: 'finance', code: 'fake-finance' },
  { name: 'Synthetic Owner', level: 'owner', code: 'fake-owner' },
  { name: 'Synthetic Member', level: 'none', code: 'fake-member' },
  // Executive-view test users: an ordinary level each, access comes only from EXEC_VIEWERS below.
  { name: 'Synthetic Head', level: 'owner', code: 'fake-head' },
  { name: 'Synthetic Ops Lead', level: 'none', code: 'fake-ops' },
];

// Stand-in for the EXEC_VIEWERS script property and the separate finance-summary sheet.
// Every number below is invented for tests and has no relation to any real company figure.
const EXEC_VIEWERS = ['Synthetic Head', 'Synthetic Ops Lead'];
// Stand-in for the OPP_SCORERS script property (admins may always score).
const OPP_SCORERS = ['Synthetic Finance', 'Synthetic Owner', 'Synthetic Head'];
const EXEC_SHEET = [
  ['會計年度', '截至月份', '指標代碼', '指標名稱', '期間', '預算金額', '實際金額', '資料來源', '資料版本', '更新日期', '確認人', '是否已結帳', '備註'],
  [2026, 12, 'revenue', '營收', 'annual', 12000000.5, '', '合成年度預算', 'TEST-BUDGET-v1', '2026/06/01', '', '否', ''],
  [2026, 12, 'net_income', '稅後淨利', 'annual', 800000.25, '', '合成年度預算', 'TEST-BUDGET-v1', '2026/06/01', '', '否', ''],
  [2026, 9, 'revenue', '營收', 'month', '', 1500000, '合成月報', 'TEST-2026-09', '2026/10/02', '', '否', ''],
  [2026, 9, 'net_income', '稅後淨利', 'month', '', 300000, '合成月報', 'TEST-2026-09', '2026/10/02', '', '否', ''],
  [2026, 9, 'net_income', '稅後淨利', 'ytd', '', 500000, '合成月報', 'TEST-2026-09', '2026/10/02', 'Synthetic Head', '是', ''],
  [2026, 8, 'net_income', '稅後淨利', 'ytd', '', 200000, '合成月報', 'TEST-2026-08', '2026/09/02', '', '否', 'older row, must not be picked'],
  [2026, 13, 'revenue', '營收', 'month', '', 1, '壞資料', 'TEST-BAD', '2026/10/02', '', '否', 'invalid month'],
  ['x', 9, 'unknown_metric', '?', 'month', '', 1, '壞資料', 'TEST-BAD', '2026/10/02', '', '否', 'invalid row'],
];
const EXEC_DECISIONS = [
  ['討論日期', '議題', '相關專案／業務', '待決策問題', '決策結果', '負責人', '完成期限', '追蹤狀態'],
  ['2026/10/20', 'Synthetic topic A', 'Synthetic Project One', 'Synthetic question needing a call?', '', 'Synthetic Head', '2026/10/31', '待決策'],
  ['2026/10/13', 'Synthetic topic B', '2B 企業專案與永續服務', 'Synthetic question B', 'Synthetic decision B', 'Synthetic Ops Lead', '2026/10/27', '執行中'],
  ['2026/10/06', 'Synthetic topic C', '', 'Synthetic question C', 'Synthetic decision C', 'Synthetic Head', '', '已完成'],
  ['not a date', 'Bad row', '', '', '', '', '', '待決策'],
];

// Same shape as the GAS v10 `config` (projects, team, people).
const CONFIG = {
  projects: [
    { id: 'test-project-1', cat: 'Test', name: 'Synthetic Project One', months: [10, 11] },
    { id: 'test-project-2', cat: 'Synthetic', name: 'Synthetic Project Two <b>"quoted"</b>', months: [11, 12] },
    { id: 'test-opportunity', cat: '企業', name: 'Synthetic Opportunity', months: [12] },
  ],
  team: {
    staffG1: ['Synthetic Admin', 'Synthetic Finance'],
    staffG2: ['Synthetic Owner', "Synthetic O'Member"],
    partner: ['Synthetic Partner'],
    roles: { 'Synthetic Admin': 'Test administration', 'Synthetic Owner': 'Test project owner' },
  },
  people: ['Synthetic Member'],
};

const STATE = {
  'test-project-1': {
    status: '進行中', assignee: 'Synthetic Owner', notes: 'Synthetic notes; no real client information.',
    startDate: '2026-10-01', endDate: '2026-11-30', estOverride: 12000, cost: 3000,
    custom: ['Synthetic planning', 'Synthetic delivery'],
    subtasks: {
      'Synthetic planning': [
        { id: 'synthetic-sub-1', name: 'Synthetic checklist', done: false, assignee: 'Synthetic Owner',
          start: '2026-10-01', end: '2026-10-15', note: 'Synthetic subtask note', audience: 'Test' },
        { id: 'synthetic-sub-3', name: 'Synthetic second item', done: false, assignee: 'Synthetic Owner',
          start: '2026-10-02', end: '2026-10-16', note: '', audience: 'Test' },
      ],
      'Synthetic delivery': [
        { id: 'synthetic-sub-2', name: 'Synthetic handover', done: false, assignee: 'Synthetic Member',
          start: '2026-11-01', end: '2026-11-15', note: '', audience: 'Test' },
      ],
    },
    eventDates: [{ date: '2026-10-20', label: 'Synthetic event' }],
    audienceOptions: ['Test', 'Synthetic'],
    estPlan: [{ month: 10, amount: 6000 }, { month: 11, amount: 6000 }],
    invoices: [{ date: '2026-10-01', no: 'SYNTHETIC-001', amount: 6000, dueDate: '2026-10-20', paid: false, paidDate: '' }],
  },
  'test-project-2': {
    status: '未開始', assignee: 'Synthetic Admin', notes: 'Synthetic comparison project.',
    startDate: '2026-11-01', endDate: '2026-12-20', estOverride: 8000, cost: 1000,
    custom: ['Synthetic preparation'], audienceOptions: ['Test'],
    estPlan: [{ month: 11, amount: 4000 }, { month: 12, amount: 4000 }],
  },
  'test-opportunity': {
    status: '提案中', assignee: 'Synthetic Owner', notes: 'Synthetic new opportunity.',
    startDate: '2026-12-01', endDate: '2026-12-31', estOverride: 5000, custom: ['Synthetic pitch'],
  },
  // Invented scores for the opportunity scorecard.
  _opp: {
    'test-opportunity': {
      scores: { 'Synthetic Finance': { fin: 4, value: 2, impact: 5, capacity: 1, certainty: 3, note: 'Synthetic reason', at: 1 } },
      decision: null,
    },
  },
  _fin: {
    'test-project-1': { rev: 12000, plan: [6000, 6000, 0, 0] },
    'test-project-2': { rev: 8000, plan: [0, 0, 4000, 4000] },
  },
};

const clone = value => JSON.parse(JSON.stringify(value));
function createFixture() { return clone({ config: CONFIG, state: STATE, users: USERS, execViewers: EXEC_VIEWERS, execSheet: EXEC_SHEET, execDecisions: EXEC_DECISIONS, oppScorers: OPP_SCORERS }); }

module.exports = { createFixture };
