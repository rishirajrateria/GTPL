// The "Check availability" form: PIN code + mobile number.
import { lead, leadAllowed, parseJSON, readBody, sameOrigin, send } from '../../lib/core.js';

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return send(403, { ok: false });
  if (!(await leadAllowed(env, request))) return send(429, { ok: false, error: 'too many' });
  const data = parseJSON(await readBody(request, 16 * 1024));
  if (!data) return send(400, { ok: false, error: 'invalid' });
  const r = await lead(env, request, data);
  return send(r.ok ? 200 : 400, { ok: r.ok, error: r.error || null });
}
