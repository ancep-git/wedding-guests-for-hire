// One processing layer for every entry point. The Telegram webhook and the
// website API both call these functions, so the same validation, permission
// checks and calculations apply to both.

import {
  RuleError, STATUS, EMPLOYEES, SALESPEOPLE, employee, requirePermission, can, normaliseRef,
  validateSale, validateExpense, parseSplit, parseAllocation, computeCommission, computeResults,
  saleConfirmation, expenseConfirmation, saleDecisionMessage, expenseDecisionMessage,
} from './rules.js';
import { SALES_HEADER, EXPENSES_HEADER, saleRow, expenseRow } from './sheets.js';

export function createService({ store, sheets = null, telegram = null, now = () => new Date().toISOString(), allowReset = false }) {
  async function settings() {
    return { simulate_sheets_failure: false, simulate_telegram_failure: false, ...(await store.getSettings()) };
  }

  // ---------- Google Sheets synchronisation ----------

  async function syncSheet(t) {
    try {
      if ((await settings()).simulate_sheets_failure) throw new Error('Simulated Google Sheets outage (switch it off in Manager setup, then retry).');
      if (!sheets) throw new Error('Google Sheets is not configured on the server.');
      if (t.kind === 'sale') await sheets.upsert('Sales', SALES_HEADER, t.ref, saleRow(t));
      else await sheets.upsert('Expenses', EXPENSES_HEADER, t.ref, expenseRow(t));
      return await store.updateTransaction(t.ref, { sync_status: 'synced', sync_error: null, synced_at: now() });
    } catch (e) {
      return await store.updateTransaction(t.ref, { sync_status: 'failed', sync_error: String(e.message).slice(0, 500) });
    }
  }

  // ---------- Telegram notifications ----------

  async function chatForEmployee(employeeId) {
    const linked = (await store.listTelegramUsers())
      .filter((u) => u.employee_id === employeeId)
      .sort((a, b) => String(b.linked_at || '').localeCompare(String(a.linked_at || '')));
    return linked[0]?.chat_id || null;
  }

  // Bot submissions go back to the chat they came from; website entries go to
  // the employee's linked chat at the time of the decision.
  async function recipientFor(t) {
    if (t.source === 'telegram' && t.origin_chat_id) return String(t.origin_chat_id);
    return chatForEmployee(t.submitted_by);
  }

  async function notifyDecision(t) {
    const message = t.kind === 'sale' ? saleDecisionMessage(t) : expenseDecisionMessage(t);
    const chatId = await recipientFor(t);
    if (!chatId) {
      return store.updateTransaction(t.ref, { notify_status: 'no_recipient', notify_error: 'No Telegram recipient linked', notify_chat_id: null, notify_message: message });
    }
    try {
      if ((await settings()).simulate_telegram_failure) throw new Error('Simulated Telegram failure (switch it off in Manager setup, then retry).');
      if (!telegram) throw new Error('Telegram bot is not configured on the server.');
      await telegram.sendMessage(chatId, message);
      return store.updateTransaction(t.ref, { notify_status: 'sent', notify_error: null, notify_chat_id: chatId, notify_message: message, notify_at: now() });
    } catch (e) {
      return store.updateTransaction(t.ref, { notify_status: 'failed', notify_error: String(e.message).slice(0, 500), notify_chat_id: chatId, notify_message: message });
    }
  }

  // ---------- submissions ----------

  function baseRow(actorId, source, chatId) {
    return {
      submitted_at: now(), submitted_by: actorId, source,
      origin_chat_id: source === 'telegram' && chatId != null ? String(chatId) : null,
      customer: null, project: null, category: null,
      proposed_split: null, final_split: null, commission_pool_cents: 0, commission_cents: null,
      proposed_allocation: null, final_allocation: null, decided_at: null, decided_by: null,
      sync_status: 'pending', sync_error: null, synced_at: null,
      notify_status: 'not_required', notify_error: null, notify_chat_id: null, notify_message: null, notify_at: null,
    };
  }

  async function submitSale(actorId, input, { source = 'web', chatId = null } = {}) {
    requirePermission(actorId, 'submit_sale');
    const v = validateSale(input);
    const row = {
      ...baseRow(actorId, source, chatId),
      ref: v.ref, kind: 'sale', customer: v.customer, project: v.project, description: v.description,
      amount_cents: v.amount_cents, proposed_split: v.proposed,
      commission_cents: { richard: 0, anastasia: 0, jeanclaude: 0 },
      status: STATUS.PENDING,
    };
    const saved = await store.insertTransaction(row);
    return syncSheet(saved);
  }

  async function submitExpense(actorId, input, { source = 'web', chatId = null } = {}) {
    requirePermission(actorId, 'submit_expense');
    const v = validateExpense(input);
    const overhead = v.proposed_allocation === 'OVERHEAD';
    const row = {
      ...baseRow(actorId, source, chatId),
      ref: v.ref, kind: 'expense', description: v.description, category: v.category, amount_cents: v.amount_cents,
      proposed_allocation: v.proposed_allocation,
      final_allocation: overhead ? 'OVERHEAD' : null,
      status: overhead ? STATUS.ALLOCATED : STATUS.AWAITING,
    };
    const saved = await store.insertTransaction(row);
    return syncSheet(saved);
  }

  // ---------- manager decisions ----------

  async function loadFor(ref, kind) {
    const t = await store.getTransaction(normaliseRef(ref));
    if (!t || t.kind !== kind) throw new RuleError(`No ${kind} with reference ${String(ref).toUpperCase()} exists.`, 'not_found');
    return t;
  }

  async function approveSale(actorId, ref, finalSplitInput = null) {
    requirePermission(actorId, 'decide');
    const t = await loadFor(ref, 'sale');
    if (t.status !== STATUS.PENDING) throw new RuleError(`Sale ${t.ref} is already approved. Nothing was changed.`, 'already_decided');
    const finalSplit = finalSplitInput ? parseSplit(finalSplitInput) : t.proposed_split;
    const { pool, amounts } = computeCommission(t.amount_cents, finalSplit);
    const updated = await store.updateTransaction(t.ref, {
      status: STATUS.APPROVED, final_split: finalSplit, commission_pool_cents: pool, commission_cents: amounts,
      decided_at: now(), decided_by: actorId, notify_status: 'pending',
    }, { ifStatus: STATUS.PENDING });
    if (!updated) throw new RuleError(`Sale ${t.ref} is already approved. Nothing was changed.`, 'already_decided');
    await syncSheet(updated);
    return notifyDecision(await store.getTransaction(t.ref));
  }

  async function allocateExpense(actorId, ref, allocationInput) {
    requirePermission(actorId, 'decide');
    const t = await loadFor(ref, 'expense');
    if (t.status !== STATUS.AWAITING) throw new RuleError(`Expense ${t.ref} is already allocated. Nothing was changed.`, 'already_decided');
    const finalAllocation = allocationInput == null || allocationInput === '' ? t.proposed_allocation : parseAllocation(allocationInput);
    const updated = await store.updateTransaction(t.ref, {
      status: STATUS.ALLOCATED, final_allocation: finalAllocation, decided_at: now(), decided_by: actorId, notify_status: 'pending',
    }, { ifStatus: STATUS.AWAITING });
    if (!updated) throw new RuleError(`Expense ${t.ref} is already allocated. Nothing was changed.`, 'already_decided');
    await syncSheet(updated);
    return notifyDecision(await store.getTransaction(t.ref));
  }

  // ---------- retries ----------

  async function visibleOrThrow(actorId, ref) {
    if (!employee(actorId)) throw new RuleError('Unknown employee. Choose a demonstration role.', 'forbidden');
    const t = await store.getTransaction(normaliseRef(ref));
    if (!t) throw new RuleError(`No transaction with reference ${ref} exists.`, 'not_found');
    if (!can(actorId, 'view_all') && t.submitted_by !== actorId) throw new RuleError('You can only act on your own submissions.', 'forbidden');
    return t;
  }

  async function retrySync(actorId, ref) {
    const t = await visibleOrThrow(actorId, ref);
    return syncSheet(t); // same reference → same row; no new transaction
  }

  async function retryNotify(actorId, ref) {
    requirePermission(actorId, 'decide');
    const t = await visibleOrThrow(actorId, ref);
    if (!t.decided_at) throw new RuleError(`${t.ref} has no manager decision to notify about yet.`, 'invalid');
    if (!['failed', 'no_recipient', 'pending'].includes(t.notify_status)) throw new RuleError(`No notification retry needed for ${t.ref} (status: ${t.notify_status}).`, 'invalid');
    return notifyDecision(t);
  }

  // ---------- reads ----------

  async function state(actorId) {
    if (!employee(actorId)) throw new RuleError('Unknown employee. Choose a demonstration role.', 'forbidden');
    const all = can(actorId, 'view_all');
    const transactions = await store.listTransactions(all ? {} : { submittedBy: actorId });
    for (const t of transactions) {
      if (t.kind === 'sale' && t.status === STATUS.PENDING) t.proposed_commission = computeCommission(t.amount_cents, t.proposed_split);
    }
    const out = { actor: employee(actorId), employees: EMPLOYEES, transactions, permissions: {
      submit_sale: can(actorId, 'submit_sale'), submit_expense: can(actorId, 'submit_expense'), decide: can(actorId, 'decide'), setup: can(actorId, 'setup'),
    } };
    if (all) {
      out.results = computeResults(await store.listTransactions());
      out.telegramUsers = await store.listTelegramUsers();
      out.settings = await settings();
      out.allowReset = allowReset;
    }
    return out;
  }

  async function results() {
    return computeResults(await store.listTransactions());
  }

  // ---------- manager setup ----------

  async function linkTelegram(actorId, userId, employeeId) {
    requirePermission(actorId, 'setup');
    const id = String(userId ?? '').trim();
    if (!/^\d{3,15}$/.test(id)) throw new RuleError('Telegram user ID must be a number (the bot shows it when you send /start).');
    if (employeeId && !employee(employeeId)) throw new RuleError('Unknown employee.');
    return store.linkTelegramUser(id, employeeId || null);
  }

  async function setSimulation(actorId, key, value) {
    requirePermission(actorId, 'setup');
    if (!['simulate_sheets_failure', 'simulate_telegram_failure'].includes(key)) throw new RuleError('Unknown setting.');
    await store.setSetting(key, !!value);
    return settings();
  }

  async function registerWebhook(actorId, baseUrl, secret) {
    requirePermission(actorId, 'setup');
    if (!telegram) throw new RuleError('TELEGRAM_BOT_TOKEN is not set in Vercel environment variables.');
    if (!secret) throw new RuleError('TELEGRAM_WEBHOOK_SECRET is not set in Vercel environment variables.');
    await telegram.setWebhook(`${baseUrl}/api/telegram`, secret);
    const me = await telegram.getMe();
    return { url: `${baseUrl}/api/telegram`, bot: me.username };
  }

  async function resetAll(actorId) {
    requirePermission(actorId, 'setup');
    if (!allowReset) throw new RuleError('Reset is disabled. Set ALLOW_RESET=true in Vercel only while clearing practice data.', 'forbidden');
    await store.deleteAllTransactions();
    if (sheets) {
      await sheets.clearData('Sales', SALES_HEADER);
      await sheets.clearData('Expenses', EXPENSES_HEADER);
    }
    return { ok: true };
  }

  // ---------- Telegram bot ----------

  const HELP = [
    'Friends Included bot. Separate fields with |',
    '',
    'Salespeople — record a sale:',
    '/sale REF | Customer | Project A or B | Description | Amount | Richard/Anastasia/Jean-Claude %',
    'e.g. /sale S01 | Olivia Rose | A | One proud uncle and an emotional grandmother | 1000 | 50/30/20',
    '',
    'Kevin — record an expense:',
    '/expense REF | Description | Materials, Travel or Other | Amount | A, B or Overhead',
    'e.g. /expense E01 | Rented suit and fake pearl necklace for the relatives | Materials | 120 | A',
    '',
    '/mine — your submissions and their status',
    '/whoami — your Telegram user ID and linked employee',
  ].join('\n');

  function parseFields(text) {
    return text.replace(/^\/\w+(@\w+)?/, '').split('|').map((s) => s.trim());
  }

  function parseSplitText(raw) {
    const parts = String(raw ?? '').split(/[\/,;\s]+/).filter(Boolean).map((p) => p.replace(/%$/, ''));
    if (parts.length !== 3) throw new RuleError('Give three commission shares for Richard/Anastasia/Jean-Claude, e.g. 50/30/20.');
    return Object.fromEntries(SALESPEOPLE.map((id, i) => [id, parts[i]]));
  }

  // Returns the reply text (or null). Sending is done by the caller.
  async function handleTelegramMessage(msg) {
    const text = String(msg?.text || '').trim();
    const from = msg?.from;
    const chat = msg?.chat;
    if (!from || !chat || !text) return null;
    await store.upsertTelegramUser({ user_id: String(from.id), chat_id: String(chat.id), username: from.username || null, first_name: from.first_name || null });
    const tgUser = await store.getTelegramUser(String(from.id));
    const emp = tgUser?.employee_id ? employee(tgUser.employee_id) : null;
    const cmd = (text.match(/^\/(\w+)/)?.[1] || '').toLowerCase();

    if (cmd === 'start' || cmd === 'help' || cmd === 'whoami' || !cmd) {
      const who = emp
        ? `You are linked to ${emp.name}.`
        : `You are not linked to an employee yet. Ask the manager to link Telegram user ID ${from.id} under Manager setup on the website.`;
      return `Your Telegram user ID: ${from.id}\n${who}${cmd === 'whoami' ? '' : `\n\n${HELP}`}`;
    }

    if (!emp) return `❌ Not recorded. Telegram user ID ${from.id} is not linked to an employee. Ask the manager to link it under Manager setup.`;

    try {
      if (cmd === 'sale') {
        const f = parseFields(text);
        if (f.length < 6) throw new RuleError('A sale needs 6 fields: REF | Customer | Project | Description | Amount | Split.');
        const t = await submitSale(emp.id, { ref: f[0], customer: f[1], project: f[2], description: f[3], amount: f[4], split: parseSplitText(f[5]) }, { source: 'telegram', chatId: chat.id });
        return saleConfirmation(t) + syncNote(t);
      }
      if (cmd === 'expense') {
        const f = parseFields(text);
        if (f.length < 5) throw new RuleError('An expense needs 5 fields: REF | Description | Category | Amount | Allocation.');
        const t = await submitExpense(emp.id, { ref: f[0], description: f[1], category: f[2], amount: f[3], allocation: f[4] }, { source: 'telegram', chatId: chat.id });
        return expenseConfirmation(t) + syncNote(t);
      }
      if (cmd === 'mine') {
        const mine = await store.listTransactions({ submittedBy: emp.id });
        if (!mine.length) return 'You have no submissions yet.';
        return mine.map((t) => `${t.ref}: €${(t.amount_cents / 100).toFixed(2)} — ${t.status.replace('_', ' ')}`).join('\n');
      }
      return `Unknown command.\n\n${HELP}`;
    } catch (e) {
      if (e instanceof RuleError || e.code === 'duplicate') return `❌ Not recorded. ${e.message}\nPlease correct it and send again.`;
      console.error(e);
      return '❌ Not recorded: the server could not save the transaction. Please try again later.';
    }
  }

  function syncNote(t) {
    return t.sync_status === 'synced' ? '' : '\n(Saved. Google Sheets copy is pending — the manager can retry it on the website.)';
  }

  return {
    submitSale, submitExpense, approveSale, allocateExpense, retrySync, retryNotify,
    state, results, linkTelegram, setSimulation, registerWebhook, resetAll, handleTelegramMessage,
  };
}
