// Visitor activity from the page's tracker (navigator.sendBeacon, text/plain JSON). Always answers 204.
// Beacons from other websites are dropped, so a third-party page cannot plant visits from its visitors.
import { eventsAllowed, ingest, parseJSON, readBody, sameOrigin, send } from '../../lib/core.js';

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request) || !eventsAllowed(request)) return send(204);
  const data = parseJSON(await readBody(request, 32 * 1024));
  if (data) {
    try { await ingest(env, request, data); } catch (e) { console.error('ingest error:', e.message); }
  }
  return send(204);
}
