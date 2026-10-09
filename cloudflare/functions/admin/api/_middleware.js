// Everything under /admin/api/ needs the sign-in cookie.
import { authed, send } from '../../../lib/core.js';

export async function onRequest({ request, env, next }) {
  if (!(await authed(request, env))) return send(401, { error: 'signed out' }, { admin: true });
  return next();
}
