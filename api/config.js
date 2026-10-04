import { getContext, send } from '../lib/context.js';

// GET /api/config — public, non-secret page configuration.
export default function handler(req, res) {
  const { publicConfig, status } = getContext();
  send(res, 200, { ok: true, config: publicConfig, integrations: status });
}
