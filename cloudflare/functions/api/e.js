// Visitor activity from the page's tracker (navigator.sendBeacon, text/plain JSON). Always answers 204.
import { eventsAllowed, ingest, parseJSON, readBody, send } from '../../lib/core.js';

export async function onRequestPost({ request, env }) {
  const raw = await readBody(request, 32 * 1024);
  if (raw !== null && eventsAllowed(request)) {
    const data = parseJSON(raw);
    if (data) {
      try { await ingest(env, request, data); } catch (e) { console.error('ingest error:', e.message); }
    }
  }
  return send(204);
}
