// Any failure (for example the D1 database not bound yet) becomes a clean 503 instead of a crash page.
// The page then shows its "please call us" message, so an enquiry is never silently lost.
import { send } from '../lib/core.js';

export async function onRequest({ request, next }) {
  try {
    return await next();
  } catch (e) {
    console.error('function error:', request.method, new URL(request.url).pathname, e && e.message);
    const admin = new URL(request.url).pathname.startsWith('/admin');
    return admin
      ? send(503, 'The admin service hit an error. If this is a new setup, check that the D1 database is bound as DB in the Cloudflare project settings and redeploy.', { type: 'text/plain', admin: true })
      : send(503, { ok: false, error: 'unavailable' });
  }
}
