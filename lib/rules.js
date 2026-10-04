// Fixed business rules for Friends Included. Pure functions: no I/O.
// Money is handled as integer cents and percentages as integer hundredths
// of a percent, so every calculation is exact.

export const SALESPEOPLE = ['richard', 'anastasia', 'jeanclaude'];

export const EMPLOYEES = [
  { id: 'richard', name: 'Richard Darling', short: 'Richard', role: 'sales' },
  { id: 'anastasia', name: 'Anastasia Ferrari', short: 'Anastasia', role: 'sales' },
  { id: 'jeanclaude', name: 'Jean-Claude Bērziņš', short: 'Jean-Claude', role: 'sales' },
  { id: 'kevin', name: 'Kevin von Whatever', short: 'Kevin', role: 'expenses' },
  { id: 'svetlana', name: 'Svetlana de Monte Carlo', short: 'Svetlana', role: 'manager' },
];

export const PROJECTS = { A: 'Respectable Relatives', B: 'Drunk University Friends' };
export const ALLOCATIONS = { A: 'Respectable Relatives', B: 'Drunk University Friends', OVERHEAD: 'Company overhead' };
export const CATEGORIES = ['Materials', 'Travel', 'Other'];

export const STATUS = {
  PENDING: 'pending',              // sale awaiting approval
  APPROVED: 'approved',            // sale approved
  AWAITING: 'awaiting_allocation', // expense awaiting allocation
  ALLOCATED: 'allocated',          // expense allocated (by manager or automatically)
};

export const STATUS_LABEL = {
  pending: 'Pending approval',
  approved: 'Approved',
  awaiting_allocation: 'Awaiting allocation',
  allocated: 'Allocated',
};

export class RuleError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.code = code;
  }
}

export function employee(id) {
  return EMPLOYEES.find((e) => e.id === id) || null;
}

export function can(employeeId, action) {
  const e = employee(employeeId);
  if (!e) return false;
  switch (action) {
    case 'submit_sale': return e.role === 'sales';
    case 'submit_expense': return e.role === 'expenses';
    case 'decide': return e.role === 'manager';
    case 'view_all': return e.role === 'manager';
    case 'setup': return e.role === 'manager';
    default: return false;
  }
}

export function requirePermission(employeeId, action) {
  if (!employee(employeeId)) throw new RuleError('Unknown employee. Choose a demonstration role.', 'forbidden');
  if (!can(employeeId, action)) {
    const e = employee(employeeId);
    const what = {
      submit_sale: 'submit sales',
      submit_expense: 'submit expenses',
      decide: 'approve or correct transactions',
      view_all: 'view all transactions',
      setup: 'change manager setup',
    }[action] || action;
    throw new RuleError(`${e.short} is not allowed to ${what}.`, 'forbidden');
  }
}

// ---------- parsing ----------

export function normaliseRef(raw) {
  const ref = String(raw ?? '').trim().toUpperCase();
  if (!ref) throw new RuleError('Reference is required.');
  if (!/^[A-Z0-9][A-Z0-9_-]{0,19}$/.test(ref)) throw new RuleError('Reference may contain only letters, digits, - and _ (max 20 characters).');
  return ref;
}

export function parseAmountCents(raw, label = 'Amount') {
  if (raw === null || raw === undefined || String(raw).trim() === '') throw new RuleError(`${label} is required.`);
  const s = String(raw).trim().replace(/^€\s*/, '').replace(/\s*€$/, '').replace(/[\s,](?=\d{3}(\D|$))/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new RuleError(`${label} must be a number in euros with at most two decimals (e.g. 1000 or 80.50).`);
  const [whole, frac = ''] = s.split('.');
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents)) throw new RuleError(`${label} is too large.`);
  if (cents <= 0) throw new RuleError(`${label} must be greater than zero.`);
  return cents;
}

// Percent -> hundredths of a percent (50 -> 5000, 33.33 -> 3333).
export function parsePercent(raw, who) {
  if (raw === null || raw === undefined || String(raw).trim() === '') throw new RuleError(`Commission share for ${who} is required (use 0 if none).`);
  const s = String(raw).trim().replace(/%$/, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new RuleError(`Commission share for ${who} must be a number from 0 to 100.`);
  const [whole, frac = ''] = s.split('.');
  const h = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  if (h > 10000) throw new RuleError(`Commission share for ${who} cannot exceed 100%.`);
  return h;
}

export function parseSplit(split) {
  if (!split || typeof split !== 'object') throw new RuleError('Proposed commission split is required.');
  const out = {};
  for (const id of SALESPEOPLE) out[id] = parsePercent(split[id], employee(id).short);
  const total = SALESPEOPLE.reduce((t, id) => t + out[id], 0);
  if (total !== 10000) throw new RuleError(`Commission shares must total 100%; they currently total ${fmtPct(total)}.`);
  return out;
}

function requireText(raw, label, max = 300) {
  const s = String(raw ?? '').trim();
  if (!s) throw new RuleError(`${label} is required.`);
  if (s.length > max) throw new RuleError(`${label} is too long (max ${max} characters).`);
  return s;
}

function parseProject(raw) {
  const s = String(raw ?? '').trim().toUpperCase();
  if (!s) throw new RuleError('Project is required (A or B).');
  if (s === 'A' || s.startsWith('RESPECT')) return 'A';
  if (s === 'B' || s.startsWith('DRUNK')) return 'B';
  throw new RuleError('Project must be A (Respectable Relatives) or B (Drunk University Friends).');
}

export function parseAllocation(raw) {
  const s = String(raw ?? '').trim().toUpperCase().replace(/[\s_-]+/g, ' ');
  if (!s) throw new RuleError('Allocation is required (A, B or Company overhead).');
  if (s === 'A' || s.startsWith('RESPECT')) return 'A';
  if (s === 'B' || s.startsWith('DRUNK')) return 'B';
  if (['OVERHEAD', 'COMPANY OVERHEAD', 'COMPANY', 'O', 'C'].includes(s)) return 'OVERHEAD';
  throw new RuleError('Allocation must be A, B or Company overhead.');
}

function parseCategory(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) throw new RuleError('Category is required (Materials, Travel or Other).');
  const c = CATEGORIES.find((x) => x.toLowerCase() === s);
  if (!c) throw new RuleError('Category must be Materials, Travel or Other.');
  return c;
}

// ---------- validation of submissions ----------

export function validateSale(input) {
  return {
    ref: normaliseRef(input.ref),
    customer: requireText(input.customer, 'Customer', 120),
    project: parseProject(input.project),
    description: requireText(input.description, 'Description'),
    amount_cents: parseAmountCents(input.amount),
    proposed: parseSplit(input.split),
  };
}

export function validateExpense(input) {
  return {
    ref: normaliseRef(input.ref),
    description: requireText(input.description, 'Description'),
    category: parseCategory(input.category),
    amount_cents: parseAmountCents(input.amount),
    proposed_allocation: parseAllocation(input.allocation),
  };
}

// ---------- commission ----------

// Pool = 10% of the sale, rounded to cents. Each share is rounded to cents; any
// rounding difference goes to the largest share (ties: Richard, Anastasia, Jean-Claude).
export function computeCommission(amountCents, split) {
  const pool = Math.round(amountCents / 10);
  const amounts = {};
  for (const id of SALESPEOPLE) amounts[id] = Math.round((pool * split[id]) / 10000);
  const diff = pool - SALESPEOPLE.reduce((t, id) => t + amounts[id], 0);
  if (diff !== 0) {
    let top = SALESPEOPLE[0];
    for (const id of SALESPEOPLE) if (split[id] > split[top]) top = id;
    amounts[top] += diff;
  }
  return { pool, amounts };
}

export function splitsEqual(a, b) {
  return SALESPEOPLE.every((id) => Number(a?.[id]) === Number(b?.[id]));
}

// ---------- results ----------

export function computeResults(transactions) {
  const p = () => ({ income: 0, commission: 0, allocated: 0, result: 0 });
  const r = {
    projects: { A: p(), B: p() },
    company: { income: 0, commission: 0, allocated: 0, overhead: 0, awaiting: 0, expenses: 0, result: 0 },
    commissionBy: { richard: 0, anastasia: 0, jeanclaude: 0 },
    pendingSales: { count: 0, amount: 0 },
    awaitingExpenses: { count: 0, amount: 0 },
  };
  for (const t of transactions) {
    if (t.kind === 'sale') {
      if (t.status === STATUS.APPROVED) {
        const pr = r.projects[t.project];
        pr.income += t.amount_cents;
        pr.commission += t.commission_pool_cents;
        for (const id of SALESPEOPLE) r.commissionBy[id] += t.commission_cents[id];
      } else {
        r.pendingSales.count += 1;
        r.pendingSales.amount += t.amount_cents;
      }
    } else if (t.kind === 'expense') {
      r.company.expenses += t.amount_cents;
      if (t.status === STATUS.ALLOCATED && (t.final_allocation === 'A' || t.final_allocation === 'B')) {
        r.projects[t.final_allocation].allocated += t.amount_cents;
      } else if (t.status === STATUS.ALLOCATED && t.final_allocation === 'OVERHEAD') {
        r.company.overhead += t.amount_cents;
      } else {
        r.company.awaiting += t.amount_cents;
        r.awaitingExpenses.count += 1;
        r.awaitingExpenses.amount += t.amount_cents;
      }
    }
  }
  for (const k of ['A', 'B']) {
    const pr = r.projects[k];
    pr.result = pr.income - pr.commission - pr.allocated;
    r.company.income += pr.income;
    r.company.commission += pr.commission;
    r.company.allocated += pr.allocated;
  }
  r.company.result = r.company.income - r.company.commission - r.company.expenses;
  r.reconciliation = {
    projectResults: r.projects.A.result + r.projects.B.result,
    overhead: r.company.overhead,
    awaiting: r.company.awaiting,
    companyResult: r.company.result,
    balances: r.projects.A.result + r.projects.B.result - r.company.overhead - r.company.awaiting === r.company.result,
  };
  return r;
}

// ---------- formatting ----------

export function fmtEur(cents) {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '−' : ''}€${whole}.${String(abs % 100).padStart(2, '0')}`;
}

export function fmtPct(h) {
  const whole = Math.floor(h / 100);
  const frac = h % 100;
  return frac ? `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}%` : `${whole}%`;
}

export function fmtSplit(split) {
  return SALESPEOPLE.map((id) => fmtPct(split[id])).join(' / ');
}

export function allocationLabel(a) {
  return ALLOCATIONS[a] || '';
}

// ---------- messages ----------

export function saleConfirmation(t) {
  return [
    `✅ Sale ${t.ref} recorded.`,
    `Amount: ${fmtEur(t.amount_cents)}`,
    `Customer: ${t.customer}`,
    `Project: ${t.project} — ${PROJECTS[t.project]}`,
    `Proposed split (Richard / Anastasia / Jean-Claude): ${fmtSplit(t.proposed_split)}`,
    `Status: ${STATUS_LABEL[t.status]}`,
  ].join('\n');
}

export function expenseConfirmation(t) {
  const auto = t.proposed_allocation === 'OVERHEAD';
  return [
    `✅ Expense ${t.ref} recorded.`,
    `Amount: ${fmtEur(t.amount_cents)} — ${t.description}`,
    `Category: ${t.category}`,
    `Proposed allocation: ${allocationLabel(t.proposed_allocation)}${t.proposed_allocation === 'OVERHEAD' ? '' : ` (${t.proposed_allocation})`}`,
    `Status: ${auto ? 'Allocated to company overhead automatically' : STATUS_LABEL[t.status]}`,
  ].join('\n');
}

export function saleDecisionMessage(t) {
  const changed = !splitsEqual(t.proposed_split, t.final_split);
  const lines = SALESPEOPLE.map((id) => {
    const name = employee(id).short;
    const fin = `${fmtPct(t.final_split[id])} (${fmtEur(t.commission_cents[id])})`;
    return changed ? `${name}: ${fmtPct(t.proposed_split[id])} → ${fin}` : `${name}: ${fin}`;
  });
  return [
    `Sale ${t.ref} approved — ${changed ? 'commission split changed' : 'proposed split approved unchanged'}.`,
    `Sale ${fmtEur(t.amount_cents)}; total commission ${fmtEur(t.commission_pool_cents)}.`,
    ...lines,
  ].join('\n');
}

export function expenseDecisionMessage(t) {
  const changed = t.final_allocation !== t.proposed_allocation;
  return changed
    ? [
        `Expense ${t.ref} — ⚠️ allocation changed.`,
        `${fmtEur(t.amount_cents)}: ${t.description}.`,
        `Proposed: ${allocationLabel(t.proposed_allocation)}. Approved: ${allocationLabel(t.final_allocation)}.`,
      ].join('\n')
    : [
        `Expense ${t.ref} — allocation confirmed.`,
        `${fmtEur(t.amount_cents)}: ${t.description}.`,
        `Final allocation: ${allocationLabel(t.final_allocation)} (as proposed).`,
      ].join('\n');
}
