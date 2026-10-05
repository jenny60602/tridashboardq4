'use strict';

// Invented test data only. These passwords have no connection to any account.
const USERS = [
  { name: 'Synthetic Admin', level: 'admin', code: 'fake-admin' },
  { name: 'Synthetic Finance', level: 'finance', code: 'fake-finance' },
  { name: 'Synthetic Owner', level: 'owner', code: 'fake-owner' },
  { name: 'Synthetic Member', level: 'none', code: 'fake-member' },
];
const CATALOG = {
  projects: [
    { id: 'test-project-1', cat: 'Test', name: 'Synthetic Project One', months: [10, 11] },
    { id: 'test-project-2', cat: 'Synthetic', name: 'Synthetic Project Two', months: [11, 12] },
  ],
  staffGroups: [['Synthetic Admin', 'Synthetic Finance'], ['Synthetic Owner', 'Synthetic Member']],
  partners: ['Synthetic Partner'],
  roles: {
    'Synthetic Admin': 'Test administration', 'Synthetic Finance': 'Test finance',
    'Synthetic Owner': 'Test project owner', 'Synthetic Member': 'Test team member',
    'Synthetic Partner': 'Test partner',
  },
};
const STATE = {
  'test-project-1': {
    status: '進行中', assignee: 'Synthetic Owner', notes: 'Synthetic notes; no real client information.',
    startDate: '2026-10-01', endDate: '2026-11-30', estOverride: 12000, cost: 3000,
    custom: ['Synthetic planning', 'Synthetic delivery'],
    subtasks: {
      'Synthetic planning': [{ id: 'synthetic-sub-1', name: 'Synthetic checklist', done: false,
        assignee: 'Synthetic Owner', start: '2026-10-01', end: '2026-10-15', note: 'Synthetic subtask note', audience: 'Test' }],
      'Synthetic delivery': [{ id: 'synthetic-sub-2', name: 'Synthetic handover', done: false,
        assignee: 'Synthetic Member', start: '2026-11-01', end: '2026-11-15', note: '', audience: 'Test' }],
    },
    eventDates: [{ date: '2026-10-20', label: 'Synthetic event' }],
    audienceOptions: ['Test', 'Synthetic'],
    estPlan: [{ month: 10, amount: 6000 }, { month: 11, amount: 6000 }],
    invoices: [{ date: '2026-10-01', no: 'SYNTHETIC-001', amount: 6000,
      dueDate: '2026-10-20', paid: false, paidDate: '' }],
  },
  'test-project-2': {
    status: '未開始', assignee: 'Synthetic Admin', notes: 'Synthetic comparison project.',
    startDate: '2026-11-01', endDate: '2026-12-20', estOverride: 8000, cost: 1000,
    custom: ['Synthetic preparation'], audienceOptions: ['Test'],
    estPlan: [{ month: 11, amount: 4000 }, { month: 12, amount: 4000 }],
  },
  _fin: {
    'test-project-1': { rev: 12000, plan: { 10: 6000, 11: 6000 } },
    'test-project-2': { rev: 8000, plan: { 11: 4000, 12: 4000 } },
  },
};
const clone = value => JSON.parse(JSON.stringify(value));
function createFixture() { return clone({ catalog: CATALOG, state: STATE, users: USERS }); }

module.exports = { createFixture };
