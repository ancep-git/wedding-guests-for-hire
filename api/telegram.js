import { getContext, readJson, send } from '../lib/context.js';

// Telegram webhook. The transaction is saved (and synced) before the
// confirmation is sent, so the bot never confirms something that was not saved.
export default async function handler(req, res) {
  const { service, telegram, webhookSecret } = getContext();
  if (req.method !== 'POST') return send(res, 200, { ok: true, info: 'Telegram webhook endpoint' });
  if (!webhookSecret || req.headers['x-telegram-bot-api-secret-token'] !== webhookSecret) {
    return send(res, 401, { ok: false });
  }
  try {
    const update = await readJson(req);
    const msg = update.message;
    const reply = await service.handleTelegramMessage(msg);
    if (reply && telegram) await telegram.sendMessage(msg.chat.id, reply);
  } catch (e) {
    console.error('Telegram update failed', e);
  }
  // Always 200 so Telegram does not re-deliver the same update.
  send(res, 200, { ok: true });
}
