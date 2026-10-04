// Runs the homework's Test 1, Test 2, rule-enforcement and integration checks
// against the real processing layer, with an in-memory store and fake
// Google Sheets / Telegram clients.  Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../lib/service.js';
import { createMemoryStore } from '../lib/store-memory.js';
import { computeCommission, fmtEur } from '../lib/rules.js';

function fakeSheets() {
  const tabs = { Sales: new Map(), Expenses: new Map() };
  let appends = 0;
  return {
    tabs,
    get appends() { return appends; },
    fail: false,
    async upsert(tab, header, ref, row) {
      if (this.fail) throw new Error('network down');
      if (!tabs[tab].has(ref)) appends += 1;
      tabs[tab].set(ref, row);
    },
    async clearData(tab) { tabs[tab].clear(); },
  };
}

function fakeTelegram() {
  return {
    sent: [],
    fail: false,
    async sendMessage(chatId, text) {
      if (this.fail) throw new Error('Forbidden: bot was blocked by the user');
      this.sent.push({ chatId: String(chatId), text });
    },
  };
}

const ME = 555000111; // the student's Telegram user ID (private chat id == user id)
const tgMsg = (text) => ({ text, from: { id: ME, first_name: 'Ance' }, chat: { id: ME, type: 'private' } });
const eur = (n) => Math.round(n * 100);

function setup() {
  let clock = Date.parse('2026-10-04T10:00:00Z');
  const store = createMemoryStore();
  const sheets = fakeSheets();
  const telegram = fakeTelegram();
  const svc = createService({ store, sheets, telegram, now: () => new Date((clock += 1000)).toISOString() });
  return { store, sheets, telegram, svc };
}

function expectResults(r, exp) {
  assert.deepEqual(
    {
      A: [r.projects.A.income, r.projects.A.commission, r.projects.A.allocated, r.projects.A.result],
      B: [r.projects.B.income, r.projects.B.commission, r.projects.B.allocated, r.projects.B.result],
      company: [r.company.income, r.company.commission, r.company.allocated, r.company.overhead, r.company.awaiting, r.company.result],
      commissionBy: r.commissionBy,
    },
    exp,
  );
  assert.ok(r.reconciliation.balances);
}

async function runTest1(ctx) {
  const { svc, telegram } = ctx;
  // Unlinked user cannot submit.
  const denied = await svc.handleTelegramMessage(tgMsg('/sale S01 | Olivia Rose | A | x | 1000 | 50/30/20'));
  assert.match(denied, /not linked/);
  // Link to Richard, submit S01 via the bot.
  await svc.linkTelegram('svetlana', ME, 'richard');
  const r1 = await svc.handleTelegramMessage(tgMsg('/sale S01 | Olivia Rose | A | One proud uncle and an emotional grandmother | 1000 | 50/30/20'));
  assert.match(r1, /Sale S01 recorded/);
  assert.match(r1, /€1,000\.00/);
  assert.match(r1, /Pending approval/);
  // Change link to Kevin, submit E01 via the bot.
  await svc.linkTelegram('svetlana', ME, 'kevin');
  const r2 = await svc.handleTelegramMessage(tgMsg('/expense E01 | Rented suit and fake pearl necklace for the relatives | Materials | 120 | A'));
  assert.match(r2, /Expense E01 recorded/);
  assert.match(r2, /Awaiting allocation/);

  const s01 = await ctx.store.getTransaction('S01');
  assert.equal(s01.submitted_by, 'richard');
  assert.equal(s01.origin_chat_id, String(ME));

  await svc.submitSale('anastasia', { ref: 'S02', customer: 'Daniel King', project: 'B', description: 'University friends, dancing, and the stripping performance', amount: '2000', split: { richard: 0, anastasia: 50, jeanclaude: 50 } });
  await svc.submitExpense('kevin', { ref: 'E02', description: 'Taxi for the grandmother; Kevin selected the wrong project', category: 'Travel', amount: '80', allocation: 'B' });
  await svc.submitExpense('kevin', { ref: 'E03', description: 'Monthly company website subscription', category: 'Other', amount: '100', allocation: 'OVERHEAD' });

  // Before manager decisions.
  const before = await svc.results();
  expectResults(before, {
    A: [0, 0, 0, 0], B: [0, 0, 0, 0],
    company: [0, 0, 0, eur(100), eur(200), eur(-300)],
    commissionBy: { richard: 0, anastasia: 0, jeanclaude: 0 },
  });
  assert.equal((await ctx.store.getTransaction('E03')).status, 'allocated');

  telegram.sent.length = 0;
  await svc.approveSale('svetlana', 'S01');
  await svc.approveSale('svetlana', 'S02', { richard: 20, anastasia: 40, jeanclaude: 40 });
  await svc.allocateExpense('svetlana', 'E01', 'A');
  await svc.allocateExpense('svetlana', 'E02', 'A');

  // S01 & E01 notifications go to the original bot chat even though the link changed.
  const s01n = telegram.sent.find((m) => m.text.startsWith('Sale S01'));
  assert.equal(s01n.chatId, String(ME));
  assert.match(s01n.text, /Richard: 50% \(€50\.00\)/);
  assert.ok(telegram.sent.find((m) => m.text.startsWith('Expense E01') && m.chatId === String(ME)));
  // S02 was entered on the website by Anastasia, who has no linked chat.
  const s02 = await ctx.store.getTransaction('S02');
  assert.equal(s02.notify_status, 'no_recipient');
  assert.equal(s02.notify_error, 'No Telegram recipient linked');
  assert.equal(s02.notify_message, [
    'Sale S02 approved — commission split changed.',
    'Sale €2,000.00; total commission €200.00.',
    'Richard: 0% → 20% (€40.00)',
    'Anastasia: 50% → 40% (€80.00)',
    'Jean-Claude: 50% → 40% (€80.00)',
  ].join('\n'));
  // E02 was entered on the website by Kevin, whose linked chat is ME.
  const e02n = telegram.sent.find((m) => m.text.startsWith('Expense E02'));
  assert.equal(e02n.chatId, String(ME));
  assert.match(e02n.text, /allocation changed/);
  assert.match(e02n.text, /€80\.00: Taxi for the grandmother/);
  assert.match(e02n.text, /Proposed: Drunk University Friends\. Approved: Respectable Relatives\./);

  expectResults(await svc.results(), {
    A: [eur(1000), eur(100), eur(200), eur(700)],
    B: [eur(2000), eur(200), 0, eur(1800)],
    company: [eur(3000), eur(300), eur(200), eur(100), 0, eur(2400)],
    commissionBy: { richard: eur(90), anastasia: eur(110), jeanclaude: eur(100) },
  });
}

async function runTest2(ctx) {
  const { svc, telegram } = ctx;
  await svc.submitSale('jeanclaude', { ref: 'S03', customer: 'Emma Stonebridge', project: 'A', description: 'Premium relatives, including an uncle presented as a surgeon', amount: '1500', split: { richard: 40, anastasia: 40, jeanclaude: 20 } });
  await svc.submitSale('richard', { ref: 'S04', customer: 'Lucas Green', project: 'B', description: 'Small group of loud university friends', amount: '800', split: { richard: 25, anastasia: 25, jeanclaude: 50 } });
  await svc.submitSale('richard', { ref: 'S05', customer: 'Mia Brooks', project: 'B', description: 'Extra guests and an embarrassing speech', amount: '600', split: { richard: 100, anastasia: 0, jeanclaude: 0 } });
  await svc.submitExpense('kevin', { ref: 'E04', description: 'Replacement costumes after an enthusiastic dance performance', category: 'Materials', amount: '250', allocation: 'B' });
  await svc.submitExpense('kevin', { ref: 'E05', description: 'Minibus for university friends; Kevin selected the wrong project again', category: 'Travel', amount: '90', allocation: 'A' });
  await svc.submitExpense('kevin', { ref: 'E06', description: 'Company telephone subscription', category: 'Other', amount: '60', allocation: 'Company overhead' });
  await svc.submitExpense('kevin', { ref: 'E07', description: 'Emergency replacement clothing; project allocation still needs checking', category: 'Materials', amount: '140', allocation: 'A' });

  telegram.sent.length = 0;
  await svc.linkTelegram('svetlana', ME, 'jeanclaude');
  await svc.approveSale('svetlana', 'S03', { richard: 20, anastasia: 30, jeanclaude: 50 });
  await svc.approveSale('svetlana', 'S04');
  await svc.linkTelegram('svetlana', ME, 'kevin');
  await svc.allocateExpense('svetlana', 'E04', 'B');
  await svc.allocateExpense('svetlana', 'E05', 'B');

  const s03 = telegram.sent.find((m) => m.text.startsWith('Sale S03'));
  assert.equal(s03.text, [
    'Sale S03 approved — commission split changed.',
    'Sale €1,500.00; total commission €150.00.',
    'Richard: 40% → 20% (€30.00)',
    'Anastasia: 40% → 30% (€45.00)',
    'Jean-Claude: 20% → 50% (€75.00)',
  ].join('\n'));
  const e05 = telegram.sent.find((m) => m.text.startsWith('Expense E05'));
  assert.match(e05.text, /€90\.00/);
  assert.match(e05.text, /Proposed: Respectable Relatives\. Approved: Drunk University Friends\./);
  assert.ok(!telegram.sent.some((m) => /S05|E07/.test(m.text.split('\n')[0])));
  // S01 (bot) keeps its original destination; S04 (website, Richard not linked now) has none.
  assert.equal((await ctx.store.getTransaction('S04')).notify_status, 'no_recipient');

  expectResults(await svc.results(), {
    A: [eur(2500), eur(250), eur(200), eur(2050)],
    B: [eur(2800), eur(280), eur(340), eur(2180)],
    company: [eur(5300), eur(530), eur(540), eur(160), eur(140), eur(3930)],
    commissionBy: { richard: eur(140), anastasia: eur(175), jeanclaude: eur(215) },
  });
  const r = await svc.results();
  assert.deepEqual(r.pendingSales, { count: 1, amount: eur(600) });
  assert.deepEqual(r.awaitingExpenses, { count: 1, amount: eur(140) });
}

test('Test 1 and Test 2 produce the expected results and notifications', async () => {
  const ctx = setup();
  await runTest1(ctx);
  await runTest2(ctx);
  // Sheets: one row per reference, with separate proposed/approved columns.
  assert.equal(ctx.sheets.tabs.Sales.size, 5);
  assert.equal(ctx.sheets.tabs.Expenses.size, 7);
  assert.equal(ctx.sheets.appends, 12);
  const s02 = ctx.sheets.tabs.Sales.get('S02');
  assert.deepEqual(s02.slice(7, 17), [0, 50, 50, 20, 40, 40, 40, 80, 80, 200]);
  assert.equal(s02[17], 'Approved');
  const s05 = ctx.sheets.tabs.Sales.get('S05');
  assert.deepEqual(s05.slice(10, 17), ['', '', '', 0, 0, 0, 0]);
  const e02 = ctx.sheets.tabs.Expenses.get('E02');
  assert.deepEqual(e02.slice(6, 10), ['Drunk University Friends', 'Respectable Relatives', 'Allocated', 'Yes']);
  const e07 = ctx.sheets.tabs.Expenses.get('E07');
  assert.deepEqual(e07.slice(6, 9), ['Respectable Relatives', '', 'Awaiting allocation']);
});

test('rule enforcement leaves control totals unchanged', async () => {
  const ctx = setup();
  await runTest1(ctx);
  await runTest2(ctx);
  const { svc } = ctx;
  const before = JSON.stringify(await svc.results());
  const rowsBefore = (await ctx.store.listTransactions()).length;

  await assert.rejects(svc.submitSale('richard', { ref: 'X1', customer: 'C', project: 'A', description: 'd', amount: '100', split: { richard: 60, anastasia: 30, jeanclaude: 20 } }), /total 100%/);
  await assert.rejects(svc.approveSale('richard', 'S05'), /not allowed/);
  await assert.rejects(svc.allocateExpense('kevin', 'E07', 'A'), /not allowed/);
  await assert.rejects(svc.submitSale('kevin', { ref: 'X2', customer: 'C', project: 'A', description: 'd', amount: '100', split: { richard: 100, anastasia: 0, jeanclaude: 0 } }), /not allowed to submit sales/);
  await assert.rejects(svc.submitExpense('richard', { ref: 'X3', description: 'd', category: 'Other', amount: '5', allocation: 'A' }), /not allowed/);
  await assert.rejects(svc.submitExpense('kevin', { ref: 'X4', description: 'd', category: 'Other', amount: '', allocation: 'A' }), /Amount is required/);
  await assert.rejects(svc.submitExpense('kevin', { ref: 'X5', description: 'd', category: 'Other', amount: '0', allocation: 'A' }), /greater than zero/);
  await assert.rejects(svc.submitExpense('kevin', { ref: 'X6', description: 'd', category: 'Other', amount: '-5', allocation: 'A' }), /Amount/);
  await assert.rejects(svc.approveSale('svetlana', 'S01'), /already approved/);
  await assert.rejects(svc.approveSale('svetlana', 'S02', { richard: 100, anastasia: 0, jeanclaude: 0 }), /already approved/);
  await assert.rejects(svc.allocateExpense('svetlana', 'E02', 'B'), /already allocated/);
  await assert.rejects(svc.allocateExpense('svetlana', 'E03', 'A'), /already allocated/);
  await assert.rejects(svc.submitSale('richard', { ref: 'S01', customer: 'C', project: 'A', description: 'd', amount: '100', split: { richard: 100, anastasia: 0, jeanclaude: 0 } }), /already exists/);
  await assert.rejects(svc.submitExpense('kevin', { ref: 's02', description: 'd', category: 'Other', amount: '5', allocation: 'A' }), /already exists/);
  // Telegram path uses the same rules.
  await svc.linkTelegram('svetlana', ME, 'kevin');
  assert.match(await svc.handleTelegramMessage(tgMsg('/sale X7 | C | A | d | 100 | 100/0/0')), /not allowed to submit sales/);
  assert.match(await svc.handleTelegramMessage(tgMsg('/expense E01 | d | Other | 5 | A')), /already exists/);
  assert.match(await svc.handleTelegramMessage(tgMsg('/expense X8 | d | Other | 0 | A')), /greater than zero/);
  await assert.rejects(svc.linkTelegram('kevin', ME, 'svetlana'), /not allowed/);

  assert.equal(JSON.stringify(await svc.results()), before);
  assert.equal((await ctx.store.listTransactions()).length, rowsBefore);
});

test('interrupted Sheets update: saved, marked failed, retry restores the same row', async () => {
  const ctx = setup();
  const { svc, sheets } = ctx;
  sheets.fail = true;
  const t = await svc.submitSale('richard', { ref: 'S90', customer: 'C', project: 'A', description: 'd', amount: '1000', split: { richard: 100, anastasia: 0, jeanclaude: 0 } });
  assert.equal(t.sync_status, 'failed');
  assert.ok(await ctx.store.getTransaction('S90'));
  assert.equal(sheets.tabs.Sales.size, 0);
  const a = await svc.approveSale('svetlana', 'S90');
  assert.equal(a.status, 'approved');
  assert.equal((await ctx.store.getTransaction('S90')).sync_status, 'failed');
  const totals = JSON.stringify(await svc.results());
  sheets.fail = false;
  const retried = await svc.retrySync('svetlana', 'S90');
  assert.equal(retried.sync_status, 'synced');
  await svc.retrySync('svetlana', 'S90');
  assert.equal(sheets.tabs.Sales.size, 1);
  assert.equal(sheets.tabs.Sales.get('S90')[17], 'Approved');
  assert.equal(JSON.stringify(await svc.results()), totals);
  assert.equal((await ctx.store.listTransactions()).length, 1);
});

test('simulated outage switch works the same way', async () => {
  const ctx = setup();
  const { svc } = ctx;
  await svc.setSimulation('svetlana', 'simulate_sheets_failure', true);
  const t = await svc.submitExpense('kevin', { ref: 'E90', description: 'd', category: 'Other', amount: '5', allocation: 'A' });
  assert.equal(t.sync_status, 'failed');
  await svc.setSimulation('svetlana', 'simulate_sheets_failure', false);
  assert.equal((await svc.retrySync('kevin', 'E90')).sync_status, 'synced');
  await assert.rejects(svc.retrySync('richard', 'E90'), /own submissions/);
});

test('failed Telegram notification keeps the decision and is not marked sent', async () => {
  const ctx = setup();
  const { svc, telegram } = ctx;
  await svc.linkTelegram('svetlana', ME, 'kevin');
  await svc.submitExpense('kevin', { ref: 'E91', description: 'Emergency underwear', category: 'Materials', amount: '12.50', allocation: 'B' });
  telegram.fail = true;
  const t = await svc.allocateExpense('svetlana', 'E91', 'A');
  assert.equal(t.status, 'allocated');
  assert.equal(t.notify_status, 'failed');
  assert.match(t.notify_error, /blocked/);
  assert.equal(telegram.sent.length, 0);
  const totals = JSON.stringify(await svc.results());
  telegram.fail = false;
  const r = await svc.retryNotify('svetlana', 'E91');
  assert.equal(r.notify_status, 'sent');
  assert.equal(telegram.sent.length, 1);
  assert.equal(JSON.stringify(await svc.results()), totals);
  await assert.rejects(svc.retryNotify('svetlana', 'E91'), /No notification retry needed/);
});

test('commission rounding gives the difference to the largest share', () => {
  // €333.33 sale → pool €33.33; 33.34/33.33/33.33 → 11.11 each = 33.33.
  assert.deepEqual(computeCommission(33333, { richard: 3334, anastasia: 3333, jeanclaude: 3333 }), { pool: 3333, amounts: { richard: 1111, anastasia: 1111, jeanclaude: 1111 } });
  // €100.05 sale → pool €10.01; 50/50/0 rounds to 5.01 + 5.01 = 10.02, so the
  // −€0.01 difference goes to the tied largest share in order: Richard.
  assert.deepEqual(computeCommission(10005, { richard: 5000, anastasia: 5000, jeanclaude: 0 }), { pool: 1001, amounts: { richard: 500, anastasia: 501, jeanclaude: 0 } });
  // €100.10 sale → pool €10.01 (10.010); 20/40/40 → 2.00 + 4.00 + 4.00, +€0.01 to Anastasia.
  assert.deepEqual(computeCommission(10010, { richard: 2000, anastasia: 4000, jeanclaude: 4000 }).amounts, { richard: 200, anastasia: 401, jeanclaude: 400 });
  // equal largest on Anastasia/Jean-Claude → Anastasia.
  const c = computeCommission(1, { richard: 0, anastasia: 5000, jeanclaude: 5000 });
  assert.equal(c.pool, 0);
  const d = computeCommission(10010, { richard: 2000, anastasia: 4000, jeanclaude: 4000 });
  assert.equal(d.amounts.richard + d.amounts.anastasia + d.amounts.jeanclaude, d.pool);
  assert.equal(fmtEur(-30000), '−€300.00');
});
