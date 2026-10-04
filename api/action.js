import { getContext, readJson, send, sendError } from '../lib/context.js';

// POST /api/action { actor, action, ...params }
// Every action re-checks the actor's permissions in lib/service.js; the
// website hiding a button is never relied on.
export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use POST.' });
  try {
    const { service, webhookSecret } = getContext();
    const b = await readJson(req);
    const actor = String(b.actor || '');
    let result;
    switch (b.action) {
      case 'submit_sale': result = await service.submitSale(actor, b.sale || {}, { source: 'web' }); break;
      case 'submit_expense': result = await service.submitExpense(actor, b.expense || {}, { source: 'web' }); break;
      case 'approve_sale': result = await service.approveSale(actor, b.ref, b.split || null); break;
      case 'allocate_expense': result = await service.allocateExpense(actor, b.ref, b.allocation); break;
      case 'retry_sync': result = await service.retrySync(actor, b.ref); break;
      case 'retry_notify': result = await service.retryNotify(actor, b.ref); break;
      case 'link_telegram': result = await service.linkTelegram(actor, b.userId, b.employeeId); break;
      case 'set_simulation': result = await service.setSimulation(actor, b.key, b.value); break;
      case 'register_webhook': {
        // Prefer the production domain: deployment-specific URLs are protected
        // by Vercel Authentication, which Telegram cannot pass.
        const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
        const proto = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        result = await service.registerWebhook(actor, prod ? `https://${prod}` : `${proto}://${host}`, webhookSecret);
        break;
      }
      case 'sheets_info': result = await service.sheetsInfo(actor); break;
      case 'webhook_info': result = await service.webhookInfo(actor); break;
      case 'reset_all': result = await service.resetAll(actor); break;
      default: return send(res, 400, { ok: false, code: 'invalid', error: 'Unknown action.' });
    }
    send(res, 200, { ok: true, result });
  } catch (e) {
    sendError(res, e);
  }
}
