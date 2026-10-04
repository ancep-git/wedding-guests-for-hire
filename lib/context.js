// Builds the service from server-side environment variables.
import { createService } from './service.js';
import { createSupabaseStore } from './store-supabase.js';
import { createMemoryStore } from './store-memory.js';
import { createSheetsClient, sheetsConfigFromEnv } from './sheets.js';
import { createTelegramClient } from './telegram.js';
import crypto from 'node:crypto';

function webhookSecretFrom(env) {
  const raw = (env.TELEGRAM_WEBHOOK_SECRET || '').trim() || env.TELEGRAM_BOT_TOKEN || '';
  return raw ? crypto.createHash('sha256').update(raw).digest('hex') : '';
}

let cached = null;

export function getContext(env = process.env) {
  if (cached) return cached;
  const supabase = env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY;
  const store = supabase
    ? createSupabaseStore({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY })
    : createMemoryStore();
  const sheetsCfg = sheetsConfigFromEnv(env);
  const sheets = sheetsCfg ? createSheetsClient(sheetsCfg) : null;
  const telegram = env.TELEGRAM_BOT_TOKEN ? createTelegramClient({ token: env.TELEGRAM_BOT_TOKEN }) : null;
  const service = createService({ store, sheets, telegram, allowReset: env.ALLOW_RESET === 'true' });
  cached = {
    service, store, telegram,
    // Telegram only accepts A-Z a-z 0-9 _ - in the secret, so send a SHA-256
    // hex digest of whatever was configured (falls back to the bot token).
    webhookSecret: webhookSecretFrom(env),
    status: { supabase: !!supabase, sheets: !!sheets, telegram: !!telegram, webhookSecret: !!(env.TELEGRAM_WEBHOOK_SECRET || env.TELEGRAM_BOT_TOKEN) },
    publicConfig: {
      studentName: env.STUDENT_NAME || 'Ance Petrovica',
      botUsername: env.TELEGRAM_BOT_USERNAME || '',
      sheetUrl: env.GOOGLE_SHEET_ID ? `https://docs.google.com/spreadsheets/d/${env.GOOGLE_SHEET_ID}/edit` : '',
      githubUrl: env.GITHUB_REPO_URL || '',
    },
  };
  return cached;
}

export function resetContextForTests() {
  cached = null;
}

export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const s = Buffer.concat(chunks).toString('utf8');
  return s ? JSON.parse(s) : {};
}

export function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

export function sendError(res, e) {
  const code = e.code || 'error';
  const status = code === 'forbidden' ? 403 : code === 'not_found' ? 404 : code === 'duplicate' || code === 'already_decided' ? 409 : code === 'invalid' ? 400 : 500;
  if (status === 500) console.error(e);
  send(res, status, { ok: false, code, error: status === 500 ? `Server error: ${e.message}` : e.message });
}
