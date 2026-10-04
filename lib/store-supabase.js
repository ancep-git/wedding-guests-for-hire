// Supabase store (source of truth). Talks to the PostgREST API with the
// service-role key, which only ever lives in server-side environment variables.

import { DuplicateRefError } from './store-errors.js';

export function createSupabaseStore({ url, key, fetchImpl = fetch }) {
  const base = url.replace(/\/+$/, '') + '/rest/v1';

  async function call(path, { method = 'GET', body, prefer } = {}) {
    const headers = { apikey: key, 'Content-Type': 'application/json' };
    // Legacy service_role keys are JWTs (eyJ…) and also go in Authorization;
    // the newer sb_secret_… keys must only be sent as apikey.
    if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
    if (prefer) headers.Prefer = prefer;
    const res = await fetchImpl(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error(`Supabase ${method} ${path.split('?')[0]} failed (${res.status}): ${data?.message || text}`);
      err.status = res.status;
      err.pgCode = data?.code;
      throw err;
    }
    return data;
  }
  const enc = encodeURIComponent;

  return {
    kind: 'supabase',

    async insertTransaction(row) {
      try {
        const [saved] = await call('/transactions', { method: 'POST', body: row, prefer: 'return=representation' });
        return saved;
      } catch (e) {
        if (e.pgCode === '23505' || e.status === 409) throw new DuplicateRefError(row.ref);
        throw e;
      }
    },

    async getTransaction(ref) {
      const rows = await call(`/transactions?ref=eq.${enc(ref)}&select=*`);
      return rows[0] || null;
    },

    async listTransactions({ submittedBy } = {}) {
      const f = submittedBy ? `&submitted_by=eq.${enc(submittedBy)}` : '';
      return call(`/transactions?select=*${f}&order=submitted_at.asc,ref.asc`);
    },

    // Conditional update: the status filter makes approval atomic, so two
    // simultaneous approvals cannot both succeed.
    async updateTransaction(ref, patch, { ifStatus } = {}) {
      const f = ifStatus ? `&status=eq.${enc(ifStatus)}` : '';
      const rows = await call(`/transactions?ref=eq.${enc(ref)}${f}`, { method: 'PATCH', body: patch, prefer: 'return=representation' });
      return rows[0] || null;
    },

    async deleteAllTransactions() {
      await call('/transactions?ref=not.is.null', { method: 'DELETE' });
    },

    async upsertTelegramUser(u) {
      const body = { user_id: String(u.user_id), chat_id: String(u.chat_id), username: u.username ?? null, first_name: u.first_name ?? null, last_seen_at: new Date().toISOString() };
      const [row] = await call('/telegram_users?on_conflict=user_id', { method: 'POST', body, prefer: 'resolution=merge-duplicates,return=representation' });
      return row;
    },

    async getTelegramUser(userId) {
      const rows = await call(`/telegram_users?user_id=eq.${enc(String(userId))}&select=*`);
      return rows[0] || null;
    },

    async listTelegramUsers() {
      return call('/telegram_users?select=*&order=last_seen_at.desc.nullslast');
    },

    async linkTelegramUser(userId, employeeId) {
      const id = String(userId);
      const existing = await this.getTelegramUser(id);
      const patch = { employee_id: employeeId, linked_at: employeeId ? new Date().toISOString() : null };
      if (existing) {
        const [row] = await call(`/telegram_users?user_id=eq.${enc(id)}`, { method: 'PATCH', body: patch, prefer: 'return=representation' });
        return row;
      }
      // Linking an ID that has not messaged the bot yet: in a private chat the
      // chat ID equals the user ID, so it can still receive notifications once
      // the person has pressed Start.
      const [row] = await call('/telegram_users', { method: 'POST', body: { user_id: id, chat_id: id, ...patch }, prefer: 'return=representation' });
      return row;
    },

    async getSettings() {
      const rows = await call('/app_settings?select=key,value');
      return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    },

    async setSetting(key, value) {
      await call('/app_settings?on_conflict=key', { method: 'POST', body: { key, value }, prefer: 'resolution=merge-duplicates' });
    },
  };
}
