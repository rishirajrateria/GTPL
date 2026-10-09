import { rangeArgs, send, summary } from '../../../lib/core.js';

export async function onRequestGet({ request, env }) {
  const [frm, to] = rangeArgs(new URL(request.url));
  return send(200, await summary(env, frm, to), { admin: true });
}
