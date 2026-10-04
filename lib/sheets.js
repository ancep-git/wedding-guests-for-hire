// Google Sheets copy of the records, via the Sheets API and a service account.
// Rows are inserted or updated by transaction reference, never appended twice.

import crypto from 'node:crypto';
import { SALESPEOPLE, STATUS, STATUS_LABEL, employee, allocationLabel, PROJECTS, splitsEqual } from './rules.js';

export const SALES_HEADER = [
  'Reference', 'Submission time (UTC)', 'Salesperson', 'Customer', 'Project', 'Description', 'Amount (€)',
  'Proposed % Richard', 'Proposed % Anastasia', 'Proposed % Jean-Claude',
  'Approved % Richard', 'Approved % Anastasia', 'Approved % Jean-Claude',
  'Commission earned € Richard', 'Commission earned € Anastasia', 'Commission earned € Jean-Claude', 'Total commission earned (€)',
  'Status', 'Split changed by manager', 'Entered via', 'Decision time (UTC)',
];

export const EXPENSES_HEADER = [
  'Reference', 'Submission time (UTC)', 'Reporter', 'Description', 'Category', 'Amount (€)',
  'Proposed allocation', 'Final allocation', 'Status', 'Allocation changed by manager', 'Entered via', 'Decision time (UTC)',
];

const ts = (iso) => (iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 19) : '');
const eur = (c) => Number((c / 100).toFixed(2));
const pct = (h) => Number((h / 100).toFixed(2));

export function saleRow(t) {
  const approved = t.status === STATUS.APPROVED;
  return [
    t.ref, ts(t.submitted_at), employee(t.submitted_by)?.short || t.submitted_by, t.customer,
    `${t.project} — ${PROJECTS[t.project]}`, t.description, eur(t.amount_cents),
    ...SALESPEOPLE.map((id) => pct(t.proposed_split[id])),
    ...SALESPEOPLE.map((id) => (approved ? pct(t.final_split[id]) : '')),
    ...SALESPEOPLE.map((id) => (approved ? eur(t.commission_cents[id]) : 0)),
    approved ? eur(t.commission_pool_cents) : 0,
    STATUS_LABEL[t.status],
    approved ? (splitsEqual(t.proposed_split, t.final_split) ? 'No' : 'Yes') : '',
    t.source === 'telegram' ? 'Telegram' : 'Website',
    ts(t.decided_at),
  ];
}

export function expenseRow(t) {
  const allocated = t.status === STATUS.ALLOCATED;
  const auto = allocated && !t.decided_by;
  return [
    t.ref, ts(t.submitted_at), employee(t.submitted_by)?.short || t.submitted_by, t.description, t.category, eur(t.amount_cents),
    allocationLabel(t.proposed_allocation),
    allocated ? allocationLabel(t.final_allocation) : '',
    auto ? 'Allocated (automatic overhead)' : STATUS_LABEL[t.status],
    allocated && !auto ? (t.final_allocation === t.proposed_allocation ? 'No' : 'Yes') : '',
    t.source === 'telegram' ? 'Telegram' : 'Website',
    ts(t.decided_at),
  ];
}

function colLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function sheetsConfigFromEnv(env = process.env) {
  let email = env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let privateKey = env.GOOGLE_PRIVATE_KEY;
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const j = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    email = email || j.client_email;
    privateKey = privateKey || j.private_key;
  }
  if (!email || !privateKey || !env.GOOGLE_SHEET_ID) return null;
  return { email, privateKey: privateKey.replace(/\\n/g, '\n'), spreadsheetId: env.GOOGLE_SHEET_ID };
}

export function createSheetsClient({ email, privateKey, spreadsheetId, fetchImpl = fetch }) {
  let token = null;
  let tokenExp = 0;

  async function accessToken() {
    if (token && Date.now() < tokenExp - 60_000) return token;
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = b64url(JSON.stringify({ iss: email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
    const sig = b64url(crypto.createSign('RSA-SHA256').update(`${header}.${claim}`).sign(privateKey));
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claim}.${sig}` }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Google auth failed: ${data.error_description || data.error || res.status}`);
    token = data.access_token;
    tokenExp = Date.now() + data.expires_in * 1000;
    return token;
  }

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetchImpl(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`Google Sheets error (${res.status}): ${data.error?.message || 'unknown'}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function ensureTab(tab, header) {
    const meta = await api('?fields=sheets.properties.title');
    if (!meta.sheets?.some((s) => s.properties.title === tab)) {
      await api(':batchUpdate', { method: 'POST', body: { requests: [{ addSheet: { properties: { title: tab, gridProperties: { frozenRowCount: 1 } } } }] } });
    }
    const last = colLetter(header.length);
    await api(`/values/${encodeURIComponent(`${tab}!A1:${last}1`)}?valueInputOption=RAW`, { method: 'PUT', body: { values: [header] } });
  }

  return {
    email,
    spreadsheetId,

    async info() {
      const meta = await api('?fields=properties.title,sheets.properties.title');
      return { email, spreadsheetId, title: meta.properties?.title, tabs: (meta.sheets || []).map((s) => s.properties.title) };
    },

    async upsert(tab, header, ref, row) {
      const last = colLetter(header.length);
      let col;
      try {
        col = await api(`/values/${encodeURIComponent(`${tab}!A:A`)}`);
      } catch (e) {
        if (e.status !== 400) throw e;
        await ensureTab(tab, header);
        col = await api(`/values/${encodeURIComponent(`${tab}!A:A`)}`);
      }
      const values = col.values || [];
      if (values[0]?.[0] !== header[0]) await ensureTab(tab, header);
      const idx = values.findIndex((r, i) => i > 0 && r[0] === ref);
      if (idx > 0) {
        const n = idx + 1;
        await api(`/values/${encodeURIComponent(`${tab}!A${n}:${last}${n}`)}?valueInputOption=RAW`, { method: 'PUT', body: { values: [row] } });
      } else {
        await api(`/values/${encodeURIComponent(`${tab}!A1:${last}1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: 'POST', body: { values: [row] } });
      }
    },

    async clearData(tab, header) {
      try {
        await api(`/values/${encodeURIComponent(`${tab}!A2:${colLetter(header.length)}`)}:clear`, { method: 'POST', body: {} });
      } catch (e) {
        if (e.status !== 400) throw e;
      }
      await ensureTab(tab, header);
    },
  };
}
