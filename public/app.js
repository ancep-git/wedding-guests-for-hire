// Website client. All rules are enforced by the server (lib/service.js);
// this file only displays data and sends requests for the selected role.

const $ = (s, el = document) => el.querySelector(s);
const SALESPEOPLE = ['richard', 'anastasia', 'jeanclaude'];
const SHORT = { richard: 'Richard', anastasia: 'Anastasia', jeanclaude: 'Jean-Claude', kevin: 'Kevin', svetlana: 'Svetlana' };
const ALLOC = { A: 'Respectable Relatives', B: 'Drunk University Friends', OVERHEAD: 'Company overhead' };
const PROJ = { A: 'A — Respectable Relatives', B: 'B — Drunk University Friends' };

let state = null;
let role = 'svetlana';
try { role = localStorage.getItem('fi-role') || 'svetlana'; } catch {}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function eur(c) {
  const neg = c < 0; const a = Math.abs(c);
  return `${neg ? '−' : ''}€${Math.floor(a / 100).toLocaleString('en-US')}.${String(a % 100).padStart(2, '0')}`;
}
function pct(h) {
  if (h == null) return '';
  const w = Math.floor(h / 100), f = h % 100;
  return f ? `${w}.${String(f).padStart(2, '0').replace(/0$/, '')}%` : `${w}%`;
}
const split = (s) => (s ? SALESPEOPLE.map((id) => pct(s[id])).join(' / ') : '');
const time = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '');

// Same rule as the server, used only for the live preview.
function previewCommission(amountCents, sp) {
  const pool = Math.round(amountCents / 10);
  const a = {};
  for (const id of SALESPEOPLE) a[id] = Math.round((pool * sp[id]) / 10000);
  const diff = pool - SALESPEOPLE.reduce((t, id) => t + a[id], 0);
  if (diff) { let top = 'richard'; for (const id of SALESPEOPLE) if (sp[id] > sp[top]) top = id; a[top] += diff; }
  return { pool, a };
}
const toH = (v) => { const n = Number(String(v).trim()); return String(v).trim() === '' || !isFinite(n) ? NaN : Math.round(n * 100); };

function toast(msg, ok = true) {
  const d = document.createElement('div');
  d.className = ok ? 'ok' : 'bad';
  d.textContent = msg;
  $('#toast').appendChild(d);
  setTimeout(() => d.remove(), ok ? 4500 : 8000);
}

async function api(action, params = {}) {
  const res = await fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actor: role, action, ...params }) });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!data.ok) throw new Error(data.error || 'Request failed');
  return data.result;
}

async function load() {
  const res = await fetch(`/api/state?actor=${encodeURIComponent(role)}`, { cache: 'no-store' });
  const data = await res.json();
  if (!data.ok) { toast(data.error, false); return; }
  state = data;
  render();
}

async function act(btn, fn, okMsg) {
  if (btn) btn.disabled = true;
  try {
    const r = await fn();
    toast(typeof okMsg === 'function' ? okMsg(r) : okMsg, true);
    await load();
    return r;
  } catch (e) {
    toast(e.message, false);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------- rendering ----------

function pill(kind, text) { return `<span class="pill ${kind}">${esc(text)}</span>`; }
function statusPill(t) {
  if (t.kind === 'sale') return t.status === 'approved' ? pill('ok', 'Approved') : pill('warn', 'Pending approval');
  if (t.status === 'allocated') return pill('ok', t.decided_by ? 'Allocated' : 'Allocated (auto overhead)');
  return pill('warn', 'Awaiting allocation');
}
function syncCell(t) {
  const p = t.sync_status === 'synced' ? pill('ok', 'Synced') : t.sync_status === 'failed' ? pill('bad', 'Sync failed') : pill('warn', 'Sync pending');
  const retry = t.sync_status !== 'synced' ? ` <button class="small ghost" data-retry-sync="${esc(t.ref)}">Retry</button>` : '';
  const err = t.sync_status === 'failed' && t.sync_error ? `<div class="small muted">${esc(t.sync_error)}</div>` : '';
  return p + retry + err;
}
function notifyCell(t) {
  const m = {
    not_required: () => pill('neutral', t.kind === 'expense' && t.status === 'allocated' && !t.decided_by ? 'Not required (auto overhead)' : 'After decision'),
    pending: () => pill('warn', 'Sending…'),
    sent: () => pill('ok', 'Sent'),
    failed: () => pill('bad', 'Notification failed'),
    no_recipient: () => pill('bad', 'No Telegram recipient linked'),
  }[t.notify_status] || (() => pill('neutral', t.notify_status));
  const retry = ['failed', 'no_recipient', 'pending'].includes(t.notify_status) && t.decided_at && state.permissions.decide
    ? ` <button class="small ghost" data-retry-notify="${esc(t.ref)}">Retry</button>` : '';
  const err = t.notify_status === 'failed' && t.notify_error ? `<div class="small muted">${esc(t.notify_error)}</div>` : '';
  const msg = t.notify_message ? `<details class="small"><summary>Message</summary><pre style="white-space:pre-wrap;margin:4px 0">${esc(t.notify_message)}</pre></details>` : '';
  return m() + retry + err + msg;
}

function renderDashboard() {
  const r = state.results;
  $('#dash-sec').hidden = !r;
  if (!r) return;
  $('#kpis').innerHTML = [
    ['Company result', eur(r.company.result)],
    ['Approved income', eur(r.company.income)],
    ['Commission expense', eur(r.company.commission)],
    ['All recorded expenses', eur(r.company.expenses)],
    [`Pending sales (${r.pendingSales.count})`, eur(r.pendingSales.amount)],
    [`Awaiting allocation (${r.awaitingExpenses.count})`, eur(r.awaitingExpenses.amount)],
  ].map(([l, v]) => `<div class="kpi"><div class="v">${v}</div><div class="l">${esc(l)}</div></div>`).join('');
  const A = r.projects.A, B = r.projects.B, C = r.company;
  const row = (l, a, b, c, cls = '') => `<tr class="${cls}"><td>${l}</td><td class="n">${a}</td><td class="n">${b}</td><td class="n">${c}</td></tr>`;
  $('#results').innerHTML = `<table><thead><tr><th>Measure</th><th class="n">A · Respectable Relatives</th><th class="n">B · Drunk University Friends</th><th class="n">Company</th></tr></thead><tbody>
    ${row('Approved income', eur(A.income), eur(B.income), eur(C.income))}
    ${row('Commission expense', eur(A.commission), eur(B.commission), eur(C.commission))}
    ${row('Allocated project expenses', eur(A.allocated), eur(B.allocated), eur(C.allocated))}
    ${row('Company overhead', '—', '—', eur(C.overhead))}
    ${row('Expenses awaiting allocation', '—', '—', eur(C.awaiting))}
    ${row('Result', eur(A.result), eur(B.result), eur(C.result), 'total')}
  </tbody></table>`;
  const rc = r.reconciliation;
  $('#recon').innerHTML = `Reconciliation: ${eur(A.result)} + ${eur(B.result)} − ${eur(rc.overhead)} overhead − ${eur(rc.awaiting)} awaiting allocation = <strong>${eur(rc.companyResult)}</strong> ${rc.balances ? pill('ok', 'balances') : pill('bad', 'does not balance')}`;
  const tot = SALESPEOPLE.reduce((t, id) => t + r.commissionBy[id], 0);
  $('#commissions').innerHTML = `<table><thead><tr><th>Salesperson</th><th class="n">Commission earned</th></tr></thead><tbody>
    ${SALESPEOPLE.map((id) => `<tr><td>${SHORT[id]}</td><td class="n">${eur(r.commissionBy[id])}</td></tr>`).join('')}
    <tr class="total"><td>Total</td><td class="n">${eur(tot)}</td></tr></tbody></table>
    <p class="muted small">Commission pool is 10% of each approved sale, split by the manager's final percentages.</p>`;
}

function renderDecisions() {
  const mgr = state.permissions.decide;
  $('#decide-note').textContent = mgr
    ? 'Inspect the original proposal, change it if needed, then approve. Items you leave here stay pending.'
    : `You are acting as ${state.actor.short}. Your own pending items are listed; only Svetlana's decisions are accepted — pressing a button here shows the server refusing it.`;
  const sales = state.transactions.filter((t) => t.kind === 'sale' && t.status === 'pending');
  $('#pending-sales').innerHTML = sales.length ? sales.map((t) => `
    <div class="decision" data-sale="${esc(t.ref)}" data-amount="${t.amount_cents}">
      <header><span>${esc(t.ref)} · ${eur(t.amount_cents)} · Project ${esc(t.project)}</span><span class="muted">${esc(SHORT[t.submitted_by])} · ${esc(t.customer)}</span></header>
      <div class="orig">${esc(t.description)}<br>Original proposal (R / A / JC): <strong>${split(t.proposed_split)}</strong> → ${SALESPEOPLE.map((id) => `${SHORT[id]} ${eur(t.proposed_commission.amounts[id])}`).join(', ')} (pool ${eur(t.proposed_commission.pool)})</div>
      <div class="row3">${SALESPEOPLE.map((id) => `<label>${SHORT[id]} % <input data-pct="${id}" inputmode="decimal" value="${t.proposed_split[id] / 100}"></label>`).join('')}</div>
      <div class="small preview muted"></div>
      <div class="actions"><button data-approve="${esc(t.ref)}">Approve sale</button></div>
    </div>`).join('') : '<p class="empty">No sales pending approval.</p>';
  for (const el of document.querySelectorAll('[data-sale]')) updateDecisionPreview(el);

  const exps = state.transactions.filter((t) => t.kind === 'expense' && t.status === 'awaiting_allocation');
  $('#pending-exp').innerHTML = exps.length ? exps.map((t) => `
    <div class="decision" data-exp="${esc(t.ref)}">
      <header><span>${esc(t.ref)} · ${eur(t.amount_cents)} · ${esc(t.category)}</span><span class="muted">${esc(SHORT[t.submitted_by])}</span></header>
      <div class="orig">${esc(t.description)}<br>Proposed allocation: <strong>${esc(ALLOC[t.proposed_allocation])}</strong></div>
      <div class="actions">
        <select data-alloc>${Object.entries(ALLOC).map(([k, v]) => `<option value="${k}" ${k === t.proposed_allocation ? 'selected' : ''}>${v}${k === t.proposed_allocation ? ' (proposed)' : ''}</option>`).join('')}</select>
        <button data-allocate="${esc(t.ref)}">Confirm allocation</button>
      </div>
    </div>`).join('') : '<p class="empty">No expenses awaiting allocation.</p>';
}

function updateDecisionPreview(el) {
  const sp = {};
  for (const id of SALESPEOPLE) sp[id] = toH($(`[data-pct="${id}"]`, el).value);
  const total = SALESPEOPLE.reduce((t, id) => t + sp[id], 0);
  const out = $('.preview', el);
  if (SALESPEOPLE.some((id) => isNaN(sp[id]))) { out.textContent = 'Enter all three percentages.'; return; }
  if (total !== 10000) { out.innerHTML = `<span class="changed">Shares total ${pct(total)} — must be 100%.</span>`; return; }
  const t = state.transactions.find((x) => x.ref === el.dataset.sale);
  const c = previewCommission(Number(el.dataset.amount), sp);
  const changed = SALESPEOPLE.some((id) => sp[id] !== t.proposed_split[id]);
  out.innerHTML = `Final: ${SALESPEOPLE.map((id) => `${SHORT[id]} ${eur(c.a[id])}`).join(', ')} (pool ${eur(c.pool)})${changed ? ' · <span class="changed">split changed</span>' : ' · as proposed'}`;
}

function renderForms() {
  const p = state.permissions;
  const all = $('#show-all-forms').checked;
  $('#sale-form').hidden = !(p.submit_sale || all);
  $('#expense-form').hidden = !(p.submit_expense || all);
  $('#entry-none').hidden = p.submit_sale || p.submit_expense || all;
  $('#sale-who').textContent = `— salesperson: ${state.actor.short}`;
  $('#exp-who').textContent = `— reporter: ${state.actor.short}`;
}

function renderRecords() {
  const mgr = state.permissions.decide;
  $('#records-h').textContent = mgr ? 'All records' : `My submissions (${state.actor.short})`;
  const sales = state.transactions.filter((t) => t.kind === 'sale');
  $('#sales-table').innerHTML = `<thead><tr><th>Ref</th><th>Submitted</th><th>Salesperson</th><th>Customer</th><th>Project</th><th>Description</th><th class="n">Amount</th>
    <th>Proposed split R/A/JC</th><th>Approved split R/A/JC</th>${SALESPEOPLE.map((id) => `<th class="n">${SHORT[id]} €</th>`).join('')}<th>Status</th><th>Via</th><th>Google Sheet</th><th>Telegram notification</th></tr></thead><tbody>
    ${sales.map((t) => {
      const ap = t.status === 'approved';
      const changed = ap && SALESPEOPLE.some((id) => t.final_split[id] !== t.proposed_split[id]);
      return `<tr><td>${esc(t.ref)}</td><td>${time(t.submitted_at)}</td><td>${esc(SHORT[t.submitted_by])}</td><td>${esc(t.customer)}</td><td>${esc(t.project)}</td><td>${esc(t.description)}</td><td class="n">${eur(t.amount_cents)}</td>
      <td>${split(t.proposed_split)}</td><td>${ap ? split(t.final_split) + (changed ? ' <span class="changed">changed</span>' : '') : ''}</td>
      ${SALESPEOPLE.map((id) => `<td class="n">${eur(ap ? t.commission_cents[id] : 0)}</td>`).join('')}
      <td>${statusPill(t)}</td><td>${t.source === 'telegram' ? 'Telegram' : 'Website'}</td><td>${syncCell(t)}</td><td>${notifyCell(t)}</td></tr>`;
    }).join('') || '<tr><td colspan="17" class="empty">No sales yet.</td></tr>'}</tbody>`;
  const exps = state.transactions.filter((t) => t.kind === 'expense');
  $('#exp-table').innerHTML = `<thead><tr><th>Ref</th><th>Submitted</th><th>Reporter</th><th>Description</th><th>Category</th><th class="n">Amount</th><th>Proposed allocation</th><th>Final allocation</th><th>Status</th><th>Via</th><th>Google Sheet</th><th>Telegram notification</th></tr></thead><tbody>
    ${exps.map((t) => {
      const changed = t.status === 'allocated' && t.final_allocation !== t.proposed_allocation;
      return `<tr><td>${esc(t.ref)}</td><td>${time(t.submitted_at)}</td><td>${esc(SHORT[t.submitted_by])}</td><td>${esc(t.description)}</td><td>${esc(t.category)}</td><td class="n">${eur(t.amount_cents)}</td>
      <td>${esc(ALLOC[t.proposed_allocation])}</td><td>${t.status === 'allocated' ? esc(ALLOC[t.final_allocation]) + (changed ? ' <span class="changed">changed</span>' : '') : ''}</td>
      <td>${statusPill(t)}</td><td>${t.source === 'telegram' ? 'Telegram' : 'Website'}</td><td>${syncCell(t)}</td><td>${notifyCell(t)}</td></tr>`;
    }).join('') || '<tr><td colspan="12" class="empty">No expenses yet.</td></tr>'}</tbody>`;
}

function renderSetup() {
  const show = !!state.permissions.setup;
  $('#setup-sec').hidden = !show;
  if (!show) return;
  const opts = (sel) => `<option value="">— not linked —</option>` + state.employees.map((e) => `<option value="${e.id}" ${e.id === sel ? 'selected' : ''}>${esc(e.name)}</option>`).join('');
  const users = state.telegramUsers || [];
  $('#tg-table').innerHTML = `<thead><tr><th>Telegram user</th><th>User ID</th><th>Linked employee</th></tr></thead><tbody>
    ${users.map((u) => `<tr><td>${esc(u.first_name || '')}${u.username ? ` @${esc(u.username)}` : ''}<div class="small muted">${u.last_seen_at ? 'last message ' + time(u.last_seen_at) : 'has not messaged the bot yet'}</div></td><td>${esc(u.user_id)}</td>
      <td><select data-link="${esc(u.user_id)}">${opts(u.employee_id)}</select></td></tr>`).join('') || '<tr><td colspan="3" class="empty">Nobody has messaged the bot yet. Open the bot and press Start.</td></tr>'}</tbody>`;
  $('#link-form [name=employeeId]').innerHTML = opts('');
  const i = state.integrations;
  const li = (ok, label, hint) => `<li>${ok ? pill('ok', 'configured') : pill('bad', 'missing')} ${label}${ok ? '' : ` <span class="small muted">${hint}</span>`}</li>`;
  $('#integrations').innerHTML = [
    li(i.supabase, 'Supabase (source of truth)', 'set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'),
    li(i.sheets, 'Google Sheets copy', 'set GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_SHEET_ID'),
    li(i.telegram, 'Telegram bot', 'set TELEGRAM_BOT_TOKEN'),
    li(i.webhookSecret, 'Telegram webhook secret', 'set TELEGRAM_WEBHOOK_SECRET'),
  ].join('');
  $('#sim-sheets').checked = !!state.settings.simulate_sheets_failure;
  $('#sim-tg').checked = !!state.settings.simulate_telegram_failure;
  $('#reset-box').hidden = !state.allowReset;
}

function renderHeader() {
  const c = state.config;
  $('#student').textContent = c.studentName;
  const set = (id, href) => { const a = $(id); if (href) { a.href = href; a.classList.remove('missing'); } else { a.removeAttribute('href'); a.classList.add('missing'); } };
  set('#link-bot', c.botUsername ? `https://t.me/${c.botUsername.replace(/^@/, '')}` : '');
  set('#link-sheet', c.sheetUrl);
  set('#link-github', c.githubUrl);
  $('#warn').innerHTML = state.integrations.supabase ? '' : '<div class="banner">Supabase is not configured, so this deployment is using temporary in-memory storage. Records will disappear. Add the Supabase environment variables in Vercel.</div>';
  const notes = { sales: 'Can submit sales and proposed commission splits; sees own submissions.', expenses: 'Can submit expenses and proposed allocations; sees own submissions.', manager: 'Sees everything; approves sales, splits and expense allocations.' };
  $('#role-note').textContent = notes[state.actor.role];
}

function render() {
  renderHeader();
  renderDashboard();
  renderDecisions();
  renderForms();
  renderRecords();
  renderSetup();
}

// ---------- events ----------

function initRoleSelect() {
  const sel = $('#role');
  const list = [['richard', 'Richard “Call Me Dick” Darling — salesperson'], ['anastasia', 'Anastasia Ferrari — salesperson'], ['jeanclaude', 'Jean-Claude Bērziņš — salesperson'], ['kevin', 'Kevin von Whatever — expenses'], ['svetlana', 'Svetlana de Monte Carlo — manager']];
  sel.innerHTML = list.map(([id, l]) => `<option value="${id}">${l}</option>`).join('');
  if (!list.some(([id]) => id === role)) role = 'svetlana';
  sel.value = role;
  sel.addEventListener('change', () => { role = sel.value; try { localStorage.setItem('fi-role', role); } catch {} load(); });
}

$('#refresh').addEventListener('click', load);
$('#show-all-forms').addEventListener('change', () => state && renderForms());

$('#sale-form').addEventListener('input', (e) => {
  const f = e.currentTarget;
  const sp = Object.fromEntries(SALESPEOPLE.map((id) => [id, toH(f[id].value)]));
  const amt = Math.round(Number(f.amount.value) * 100);
  const out = $('#sale-preview');
  if (SALESPEOPLE.some((id) => isNaN(sp[id]))) { out.textContent = ''; return; }
  const total = SALESPEOPLE.reduce((t, id) => t + sp[id], 0);
  if (total !== 10000) { out.innerHTML = `<span class="changed">Shares total ${pct(total)} — must be 100%.</span>`; return; }
  if (!(amt > 0)) { out.textContent = 'Shares total 100%.'; return; }
  const c = previewCommission(amt, sp);
  out.textContent = `Pool ${eur(c.pool)}: ${SALESPEOPLE.map((id) => `${SHORT[id]} ${eur(c.a[id])}`).join(', ')} (earned only after approval)`;
});

$('#sale-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const sale = { ref: f.ref.value, customer: f.customer.value, project: f.project.value, description: f.description.value, amount: f.amount.value, split: Object.fromEntries(SALESPEOPLE.map((id) => [id, f[id].value])) };
  act(f.querySelector('button'), () => api('submit_sale', { sale }), (t) => { f.reset(); $('#sale-preview').textContent = ''; return `Sale ${t.ref} saved: ${eur(t.amount_cents)}, project ${t.project}, pending approval.${t.sync_status !== 'synced' ? '\nGoogle Sheets: sync failed — retry from the record.' : ''}`; });
});

$('#expense-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const expense = { ref: f.ref.value, description: f.description.value, category: f.category.value, amount: f.amount.value, allocation: f.allocation.value };
  act(f.querySelector('button'), () => api('submit_expense', { expense }), (t) => { f.reset(); return `Expense ${t.ref} saved: ${eur(t.amount_cents)}, ${t.status === 'allocated' ? 'allocated to company overhead automatically' : `proposed ${ALLOC[t.proposed_allocation]}, awaiting allocation`}.${t.sync_status !== 'synced' ? '\nGoogle Sheets: sync failed — retry from the record.' : ''}`; });
});

const notifyText = (t) => ({ sent: 'Telegram notification sent.', failed: 'Telegram notification FAILED — retry from the record.', no_recipient: 'No Telegram recipient linked.' }[t.notify_status] || '');

document.addEventListener('input', (e) => {
  const d = e.target.closest('[data-sale]');
  if (d && e.target.matches('[data-pct]')) updateDecisionPreview(d);
});

document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.approve) {
    const d = b.closest('[data-sale]');
    const sp = Object.fromEntries(SALESPEOPLE.map((id) => [id, $(`[data-pct="${id}"]`, d).value]));
    act(b, () => api('approve_sale', { ref: b.dataset.approve, split: sp }), (t) => `Sale ${t.ref} approved. Commission ${eur(t.commission_pool_cents)}. ${notifyText(t)}`);
  } else if (b.dataset.allocate) {
    const d = b.closest('[data-exp]');
    act(b, () => api('allocate_expense', { ref: b.dataset.allocate, allocation: $('[data-alloc]', d).value }), (t) => `Expense ${t.ref} allocated to ${ALLOC[t.final_allocation]}. ${notifyText(t)}`);
  } else if (b.dataset.retrySync) {
    act(b, () => api('retry_sync', { ref: b.dataset.retrySync }), (t) => (t.sync_status === 'synced' ? `${t.ref} synced to Google Sheets (same row).` : `${t.ref}: sync still failing — ${t.sync_error}`));
  } else if (b.dataset.retryNotify) {
    act(b, () => api('retry_notify', { ref: b.dataset.retryNotify }), (t) => `${t.ref}: ${notifyText(t) || t.notify_status}`);
  }
});

document.addEventListener('change', (e) => {
  const s = e.target;
  if (s.dataset.link !== undefined && s.dataset.link) {
    act(null, () => api('link_telegram', { userId: s.dataset.link, employeeId: s.value || null }), () => `Telegram user ${s.dataset.link} ${s.value ? `linked to ${SHORT[s.value]}` : 'unlinked'}.`);
  }
});

$('#link-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  act(f.querySelector('button'), () => api('link_telegram', { userId: f.userId.value, employeeId: f.employeeId.value || null }), () => { const m = `Telegram user ${f.userId.value} linked.`; f.reset(); return m; });
});

$('#sim-sheets').addEventListener('change', (e) => act(null, () => api('set_simulation', { key: 'simulate_sheets_failure', value: e.target.checked }), `Sheets outage simulation ${e.target.checked ? 'ON' : 'off'}.`));
$('#sim-tg').addEventListener('change', (e) => act(null, () => api('set_simulation', { key: 'simulate_telegram_failure', value: e.target.checked }), `Telegram failure simulation ${e.target.checked ? 'ON' : 'off'}.`));
$('#webhook-btn').addEventListener('click', (e) => act(e.currentTarget, () => api('register_webhook'), (r) => `Webhook registered for @${r.bot}: ${r.url}`));
$('#reset-btn').addEventListener('click', (e) => {
  if (prompt('This deletes ALL transactions in Supabase and the Google Sheet. Type DELETE to confirm.') !== 'DELETE') return;
  act(e.currentTarget, () => api('reset_all'), 'All transactions deleted.');
});

initRoleSelect();
load();
