// In-memory store with the same interface as the Supabase store.
// Used by the automated tests and by the local dev server when no Supabase
// credentials are configured.

import { DuplicateRefError } from './store-errors.js';

const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

export function createMemoryStore() {
  const tx = new Map();
  const tgUsers = new Map();
  const settings = new Map();

  return {
    kind: 'memory',

    async insertTransaction(row) {
      if (tx.has(row.ref)) throw new DuplicateRefError(row.ref);
      tx.set(row.ref, clone(row));
      return clone(row);
    },

    async getTransaction(ref) {
      return clone(tx.get(ref) || null);
    },

    async listTransactions({ submittedBy } = {}) {
      return [...tx.values()]
        .filter((t) => !submittedBy || t.submitted_by === submittedBy)
        .sort((a, b) => (a.submitted_at < b.submitted_at ? -1 : a.submitted_at > b.submitted_at ? 1 : a.ref.localeCompare(b.ref)))
        .map(clone);
    },

    // Updates only if the current status equals ifStatus (when given).
    // Returns the updated row, or null when the condition did not match.
    async updateTransaction(ref, patch, { ifStatus } = {}) {
      const cur = tx.get(ref);
      if (!cur) return null;
      if (ifStatus && cur.status !== ifStatus) return null;
      const next = { ...cur, ...clone(patch) };
      tx.set(ref, next);
      return clone(next);
    },

    async deleteAllTransactions() {
      tx.clear();
    },

    async upsertTelegramUser(u) {
      const cur = tgUsers.get(String(u.user_id)) || { employee_id: null, linked_at: null };
      const next = { ...cur, ...u, user_id: String(u.user_id), last_seen_at: new Date().toISOString() };
      tgUsers.set(next.user_id, next);
      return clone(next);
    },

    async getTelegramUser(userId) {
      return clone(tgUsers.get(String(userId)) || null);
    },

    async listTelegramUsers() {
      return [...tgUsers.values()].map(clone);
    },

    async linkTelegramUser(userId, employeeId) {
      const id = String(userId);
      const cur = tgUsers.get(id) || { user_id: id, chat_id: id, username: null, first_name: null, last_seen_at: null };
      const next = { ...cur, employee_id: employeeId, linked_at: employeeId ? new Date().toISOString() : null };
      tgUsers.set(id, next);
      return clone(next);
    },

    async getSettings() {
      return Object.fromEntries(settings);
    },

    async setSetting(key, value) {
      settings.set(key, value);
    },
  };
}
