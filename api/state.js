import { getContext, send, sendError } from '../lib/context.js';

// GET /api/state?actor=<employee id> — what the selected demonstration role may see.
export default async function handler(req, res) {
  try {
    const { service, status, publicConfig } = getContext();
    const url = new URL(req.url, 'http://x');
    const actor = url.searchParams.get('actor') || '';
    const data = await service.state(actor);
    send(res, 200, { ok: true, config: publicConfig, integrations: status, ...data });
  } catch (e) {
    sendError(res, e);
  }
}
