// Leads, visitor activity and the /admin dashboard for ill.gtplkcbpl.com on Cloudflare Pages.
// A port of server/ill_backend.py (the self-hosted version) to Pages Functions + D1.
//
// Bindings (Pages project -> Settings -> Bindings / Variables and secrets):
//   DB              D1 database (required)
//   ADMIN_PASSWORD  secret, at least 10 characters (required); also keys the login cookie,
//                   so changing it signs everyone out
//
// D1's free plan allows 100,000 rows written a day, so activity is stored as one row per visit
// with its counters in a JSON column, not one row per event: a typical visit costs 5-10 writes.
import ADMIN_HTML from '../../server/admin.html';

const IST = 19800; // UTC+5:30, no daylight saving
const SID_RE = /^[a-z0-9]{8,40}$/;
const PHONE_RE = /^[6-9]\d{9}$/;
const PIN_RE = /^[1-9]\d{5}$/;
const BOT_RE = /bot|crawl|spider|slurp|preview|headless|lighthouse|pingdom|monitor|curl|wget|python-requests|facebookexternalhit|whatsapp/i;
const EVENT_TYPES = new Set(['view', 'click_call', 'copy_phone', 'click_whatsapp', 'click_quote', 'form_start',
  'form_field', 'form_error', 'sector_open', 'section_view', 'scroll']);
const INTERACTIVE = ['click_call', 'copy_phone', 'click_whatsapp', 'click_quote', 'form_start', 'form_field',
  'form_error', 'sector_open'];
export const STATUSES = ['new', 'contacted', 'qualified', 'won', 'lost', 'spam'];
const ENGAGED_MS = 10000;
const RETENTION_DAYS = 400;      // visits older than this are deleted; leads are kept
const MAX_WRITES_PER_VISIT = 150; // a tab left open for hours stops costing writes
const COOKIE = 'ill_admin';
const COOKIE_TTL = 12 * 3600;

// ------------------------------------------------------------------------------------------ schema
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sessions(
     id TEXT PRIMARY KEY, visitor TEXT, is_return INTEGER DEFAULT 0, started REAL, last REAL,
     ref_host TEXT DEFAULT '', utm_source TEXT DEFAULT '', utm_medium TEXT DEFAULT '', utm_campaign TEXT DEFAULT '',
     utm_term TEXT DEFAULT '', utm_content TEXT DEFAULT '', click_id TEXT DEFAULT '',
     device TEXT DEFAULT '', browser TEXT DEFAULT '', os TEXT DEFAULT '', lang TEXT DEFAULT '', screen TEXT DEFAULT '',
     engaged_ms INTEGER DEFAULT 0, max_scroll INTEGER DEFAULT 0, bot INTEGER DEFAULT 0,
     ev TEXT DEFAULT '{}', writes INTEGER DEFAULT 0)`,
  'CREATE INDEX IF NOT EXISTS sessions_started ON sessions(started)',
  `CREATE TABLE IF NOT EXISTS leads(
     id INTEGER PRIMARY KEY, ts REAL, sid TEXT, phone TEXT, pin TEXT,
     status TEXT DEFAULT 'new', note TEXT DEFAULT '', updated REAL,
     source TEXT DEFAULT '', medium TEXT DEFAULT '', campaign TEXT DEFAULT '', device TEXT DEFAULT '', ref_host TEXT DEFAULT '')`,
  'CREATE INDEX IF NOT EXISTS leads_ts ON leads(ts)',
  'CREATE INDEX IF NOT EXISTS leads_phone ON leads(phone)',
  'CREATE TABLE IF NOT EXISTS throttle(k TEXT PRIMARY KEY, n INTEGER, reset REAL)',
];
let schemaReady = false;
export async function db(env) {
  if (!env.DB) throw new Error('D1 binding "DB" is missing');
  if (!schemaReady) {
    await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
    schemaReady = true;
  }
  return env.DB;
}

// ------------------------------------------------------------------------------------------ helpers
const now = () => Date.now() / 1000;
export function clean(v, n = 120) {
  return String(v ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, n);
}
const label = v => clean(v, 40).replace(/[^A-Za-z0-9_-]/g, '');

export function parseUA(ua) {
  const u = ua || '';
  const device = /iPad|Tablet|(Android(?!.*Mobile))/.test(u) ? 'tablet' : /Mobi|iPhone|Android/.test(u) ? 'mobile' : 'desktop';
  const pick = list => (list.find(([, re]) => re.test(u)) || ['Other'])[0];
  const browser = pick([['Edge', /Edg\//], ['Samsung', /SamsungBrowser/], ['Opera', /OPR\/|Opera/], ['Chrome', /Chrome\/|CriOS/],
    ['Firefox', /Firefox\/|FxiOS/], ['Safari', /Safari\//]]);
  const os = pick([['Android', /Android/], ['iOS', /iPhone|iPad|iPod/], ['Windows', /Windows/], ['macOS', /Mac OS X/], ['Linux', /Linux/]]);
  return { device, browser, os };
}

const AI_HOSTS = [['chatgpt.com', 'chatgpt'], ['chat.openai.com', 'chatgpt'], ['perplexity.ai', 'perplexity'],
  ['gemini.google.com', 'gemini'], ['claude.ai', 'claude'], ['copilot.microsoft.com', 'copilot']];
const SOCIAL = [['facebook', 'facebook'], ['fb', 'facebook'], ['instagram', 'instagram'], ['linkedin', 'linkedin'],
  ['lnkd.in', 'linkedin'], ['t.co', 'x'], ['twitter', 'x'], ['x.com', 'x'], ['whatsapp', 'whatsapp'], ['wa.me', 'whatsapp'],
  ['youtube', 'youtube'], ['reddit', 'reddit']];
const SEARCH = ['google.', 'bing.', 'yahoo.', 'duckduckgo.', 'ecosia.', 'yandex.'];

/** [source, medium] for a visit, the way an ads team reads it. */
export function sourceOf(s) {
  if (s.utm_source) return [s.utm_source.toLowerCase(), (s.utm_medium || '(not set)').toLowerCase()];
  if (s.click_id === 'gclid') return ['google', 'cpc'];
  if (s.click_id === 'fbclid') return ['facebook', 'social'];
  if (s.click_id === 'msclkid') return ['bing', 'cpc'];
  const ref = (s.ref_host || '').toLowerCase();
  if (!ref) return ['(direct)', '(none)'];
  for (const [h, name] of AI_HOSTS) if (ref.includes(h)) return [name, 'ai-assistant'];
  for (const h of SEARCH) if (ref.startsWith(h) || ref.includes('.' + h)) return [h.slice(0, -1), 'organic'];
  for (const [h, name] of SOCIAL) {
    if (ref === h || ref.startsWith(h + '.') || ref.includes('.' + h + '.') || ref.endsWith('.' + h)) return [name, 'social'];
  }
  return [ref.startsWith('www.') ? ref.slice(4) : ref, 'referral'];
}

export const istDay = ts => new Date((ts + IST) * 1000).toISOString().slice(0, 10);
/** 'YYYY-MM-DD' in IST -> UTC epoch seconds of that IST midnight; NaN if malformed. */
export function dayStart(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return NaN;
  const t = Date.parse(s + 'T00:00:00Z');
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s ? NaN : t / 1000 - IST;
}
export function rangeArgs(url) {
  const today = istDay(now());
  let frm = url.searchParams.get('from') || today, to = url.searchParams.get('to') || today;
  if (Number.isNaN(dayStart(frm)) || Number.isNaN(dayStart(to))) frm = to = today;
  if (frm > to) [frm, to] = [to, frm];
  return [frm, to];
}
const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : 0);

// ------------------------------------------------------------------------------------------ responses
const BASE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const ADMIN_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
};
export function send(status, body = '', { type = 'application/json', admin = false, headers = {} } = {}) {
  if (body !== null && typeof body === 'object') body = JSON.stringify(body);
  const h = { ...BASE_HEADERS, ...(admin ? ADMIN_HEADERS : {}), ...headers };
  if (body !== '' && body !== null) h['Content-Type'] = type + (/^(text|application\/json)/.test(type) ? '; charset=utf-8' : '');
  return new Response(status === 204 ? null : body, { status, headers: h });
}
export const ip = request => request.headers.get('CF-Connecting-IP') || '0.0.0.0';

/** Requests from another site's page carry its Origin; same-origin and non-browser requests pass.
 *  A browser sends "Origin: null" for some same-site form posts, so then its Sec-Fetch-Site decides. */
export function sameOrigin(request) {
  const o = request.headers.get('Origin');
  if (!o) return true;
  if (o === 'null') return request.headers.get('Sec-Fetch-Site') === 'same-origin';
  try { return new URL(o).host === new URL(request.url).host; } catch { return false; }
}

export async function readBody(request, limit) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > limit) return null;
  const buf = await request.arrayBuffer();
  return buf.byteLength > limit ? null : new TextDecoder().decode(buf);
}
const parseJSON = s => { try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return null; } };

// Fixed-window counter in D1, shared by every Cloudflare location (memory is per isolate).
async function throttleHit(env, key, limit, windowS) {
  const t = now();
  const row = await (await db(env)).prepare(
    `INSERT INTO throttle(k, n, reset) VALUES(?1, 1, ?2)
     ON CONFLICT(k) DO UPDATE SET n = CASE WHEN reset <= ?3 THEN 1 ELSE n + 1 END,
                                  reset = CASE WHEN reset <= ?3 THEN ?2 ELSE reset END
     RETURNING n`).bind(key, t + windowS, t).first();
  return row.n <= limit;
}
async function throttleCount(env, key) {
  const row = await (await db(env)).prepare('SELECT n, reset FROM throttle WHERE k = ?').bind(key).first();
  return row && row.reset > now() ? row.n : 0;
}

// Best-effort per-isolate limit for the activity endpoint (cheap; D1 writes are the scarce resource).
const evHits = new Map();
function evAllow(key) {
  const t = Date.now(), w = evHits.get(key);
  if (!w || t - w.start > 60000) { evHits.set(key, { start: t, n: 1 }); if (evHits.size > 5000) evHits.clear(); return true; }
  return ++w.n <= 240;
}

// ------------------------------------------------------------------------------------------ auth
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
async function hmacKey(env) {
  return crypto.subtle.importKey('raw', enc.encode('ill-admin-cookie-v1:' + env.ADMIN_PASSWORD), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}
async function sign(env, msg) { return hex(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(msg))); }
function safeEqual(a, b) {
  const x = enc.encode(a), y = enc.encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}
export function passwordConfigured(env) { return typeof env.ADMIN_PASSWORD === 'string' && env.ADMIN_PASSWORD.length >= 10; }
async function passwordOk(env, pw) {
  const [a, b] = await Promise.all([pw, env.ADMIN_PASSWORD].map(s => crypto.subtle.digest('SHA-256', enc.encode(String(s)))));
  return crypto.subtle.timingSafeEqual(a, b);
}
async function makeToken(env) {
  const exp = Math.floor(now()) + COOKIE_TTL;
  const nonce = hex(crypto.getRandomValues(new Uint8Array(8)));
  return `${exp}.${nonce}.${await sign(env, `${exp}.${nonce}`)}`;
}
export async function authed(request, env) {
  if (!passwordConfigured(env)) return false;
  const m = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)ill_admin=([^;]+)/);
  if (!m) return false;
  const [exp, nonce, mac] = m[1].split('.');
  if (!exp || !nonce || !mac || !(Number(exp) > now())) return false;
  return safeEqual(mac, await sign(env, `${exp}.${nonce}`));
}
const isHttps = request => new URL(request.url).protocol === 'https:';

// ------------------------------------------------------------------------------------------ ingestion
export async function ingest(env, request, data) {
  const ua = request.headers.get('User-Agent') || '';
  const sid = clean(data.sid, 40), vid = clean(data.vid, 40);
  if (!SID_RE.test(sid) || !SID_RE.test(vid) || BOT_RE.test(ua)) return;
  const t = now();
  const meta = data.meta && typeof data.meta === 'object' ? data.meta : null;
  const eng = data.eng && typeof data.eng === 'object' ? data.eng : {};
  const ms = Math.max(0, Math.min(parseInt(eng.ms, 10) || 0, 6 * 3600 * 1000));
  const sc = Math.max(0, Math.min(parseInt(eng.sc, 10) || 0, 100));
  const counts = {};
  for (const e of Array.isArray(data.ev) ? data.ev.slice(0, 60) : []) {
    if (!e || typeof e !== 'object') continue;
    const type = clean(e.t, 20);
    if (!EVENT_TYPES.has(type)) continue;
    const k = type + ':' + label(e.l);
    counts[k] = (counts[k] || 0) + 1;
  }
  const keys = Object.keys(counts).slice(0, 30);
  const D = await db(env);

  if (meta) {
    const { device, browser, os } = parseUA(ua);
    let ref = clean(meta.ref, 120).toLowerCase();
    if (ref.startsWith('ill.') && ref.endsWith('gtplkcbpl.com')) ref = '';
    const ev = JSON.stringify(Object.fromEntries(keys.map(k => [k, counts[k]])));
    const res = await D.prepare(
      `INSERT OR IGNORE INTO sessions(id, visitor, is_return, started, last, ref_host, utm_source, utm_medium, utm_campaign,
         utm_term, utm_content, click_id, device, browser, os, lang, screen, engaged_ms, max_scroll, ev, writes)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).bind(
      sid, vid, meta.ret ? 1 : 0, t, t, ref, clean(meta.us, 80), clean(meta.um, 80), clean(meta.uc, 120),
      clean(meta.ut, 120), clean(meta.ux, 120), { g: 'gclid', f: 'fbclid', m: 'msclkid' }[clean(meta.ck, 2)] || '',
      device, browser, os, clean(meta.lang, 12), clean(meta.scr, 12), ms, sc, ev).run();
    if (res.meta.changes) { if (Math.random() < 0.01) await prune(D); return; }
    // already known (a retried first flush): fall through and merge
  }
  // Merge counters atomically in one UPDATE: json_set(ev, path1, old1 + n1, path2, old2 + n2, ...)
  let expr = 'ev', args = [];
  if (keys.length) {
    const parts = keys.map(() => `?, CAST(COALESCE(json_extract(ev, ?), 0) + ? AS INTEGER)`);
    expr = `json_set(ev, ${parts.join(', ')})`;
    for (const k of keys) { const p = `$."${k}"`; args.push(p, p, counts[k]); }
  }
  await D.prepare(
    `UPDATE sessions SET last = ?, engaged_ms = MAX(engaged_ms, ?), max_scroll = MAX(max_scroll, ?), ev = ${expr},
       writes = writes + 1
     WHERE id = ? AND visitor = ? AND bot = 0 AND writes < ? AND length(ev) < 4000`).bind(
    t, ms, sc, ...args, sid, vid, MAX_WRITES_PER_VISIT).run();
}

// Run on about 1 in 100 new visits: old visits and expired rate-limit counters go.
async function prune(D) {
  const t = now();
  await D.batch([D.prepare('DELETE FROM sessions WHERE started < ?').bind(t - RETENTION_DAYS * 86400),
                 D.prepare('DELETE FROM throttle WHERE reset < ?').bind(t)]);
}

async function markBot(env, sid) {
  if (SID_RE.test(sid || '')) await (await db(env)).prepare('UPDATE sessions SET bot = 1 WHERE id = ?').bind(sid).run();
  return { ok: true };
}

/** Returns {ok, error?}. Bots get a fake success so they learn nothing. */
export async function lead(env, request, data) {
  const ua = request.headers.get('User-Agent') || '';
  const sid = clean(data.sid, 40);
  if (clean(data.hp, 200)) return markBot(env, sid); // honeypot field filled in
  const phone = clean(data.phone, 20).replace(/\D/g, '').slice(-10);
  const pin = clean(data.pin, 10);
  if (!PHONE_RE.test(phone) || !PIN_RE.test(pin)) return { ok: false, error: 'invalid' };
  const elapsed = Number(data.t);
  if (Number.isFinite(elapsed) && elapsed < 2500) return markBot(env, sid); // faster than a person can type
  const D = await db(env);
  const s = SID_RE.test(sid) ? await D.prepare('SELECT * FROM sessions WHERE id = ?').bind(sid).first() : null;
  let src = '(unknown)', med = '(unknown)', camp = '', dev = parseUA(ua).device, ref = '';
  if (s) { [src, med] = sourceOf(s); camp = s.utm_campaign; dev = s.device; ref = s.ref_host; }
  const t = now();
  const dup = await D.prepare('SELECT id FROM leads WHERE phone = ? AND ts > ?').bind(phone, t - 3600).first();
  if (dup) return { ok: true }; // same number again within the hour: keep one lead
  await D.prepare(`INSERT INTO leads(ts, sid, phone, pin, source, medium, campaign, device, ref_host, updated)
                   VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(t, sid, phone, pin, src, med, camp, dev, ref, t).run();
  return { ok: true };
}
export const leadAllowed = (env, request) => throttleHit(env, 'lead:' + ip(request), 6, 600);
export const eventsAllowed = request => evAllow(ip(request));

// ------------------------------------------------------------------------------------------ login
export const LOGIN_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Sign in · ILL admin</title>
<style>:root{color-scheme:light dark;--bg:#f5f7fb;--card:#fff;--ink:#101d30;--mut:#5b6b80;--line:#d9e0ea;--blue:#2458a4;--red:#c4302b}
@media (prefers-color-scheme:dark){:root{--bg:#0d1626;--card:#15213a;--ink:#eef2f8;--mut:#a3b1c6;--line:#2a3a57;--blue:#6d9be0;--red:#f07a74}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
form{width:min(360px,100%);background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px}
h1{margin:0 0 4px;font-size:20px}p{margin:0 0 20px;color:var(--mut);font-size:13.5px}label{display:block;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);margin-bottom:6px}
input{width:100%;height:44px;padding:0 12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--ink);font:inherit}
input:focus{outline:2px solid var(--blue);outline-offset:1px}button{width:100%;height:44px;margin-top:16px;border:0;border-radius:10px;background:var(--blue);color:#fff;font:inherit;font-weight:700;cursor:pointer}
.err{margin-top:12px;color:var(--red);font-size:13px}</style></head><body>
<form method="post" action="/admin/login"><h1>ILL admin</h1><p>Leads and visitor activity for ill.gtplkcbpl.com</p>
<label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Sign in</button>__ERR__</form></body></html>`;
const loginPage = (msg = '') => LOGIN_HTML.replace('__ERR__', msg ? `<p class="err" role="alert">${msg}</p>` : '');
const NOT_SET_UP = loginPage('The admin password is not set up yet. In Cloudflare, add a secret named ADMIN_PASSWORD (10+ characters) and redeploy.');

export async function adminPage(request, env) {
  if (!passwordConfigured(env)) return send(200, NOT_SET_UP, { type: 'text/html', admin: true });
  if (!(await authed(request, env))) return send(200, loginPage(), { type: 'text/html', admin: true });
  return send(200, ADMIN_HTML, { type: 'text/html', admin: true });
}

export async function login(request, env) {
  if (!sameOrigin(request)) return send(403, 'Forbidden', { type: 'text/plain', admin: true });
  if (!passwordConfigured(env)) return send(503, NOT_SET_UP, { type: 'text/html', admin: true });
  await db(env);
  const key = 'login:' + ip(request);
  if ((await throttleCount(env, key)) >= 5) {
    return send(429, loginPage('Too many attempts. Try again in 15 minutes.'), { type: 'text/html', admin: true });
  }
  const raw = (await readBody(request, 4096)) || '';
  const pw = new URLSearchParams(raw).get('password') || '';
  if (await passwordOk(env, pw)) {
    const cookie = `${COOKIE}=${await makeToken(env)}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${COOKIE_TTL}` + (isHttps(request) ? '; Secure' : '');
    return send(303, '', { type: 'text/plain', headers: { Location: '/admin', 'Set-Cookie': cookie } });
  }
  await throttleHit(env, key, 5, 900);
  const locked = (await throttleCount(env, key)) >= 5;
  return send(401, loginPage(locked ? 'Too many attempts. Try again in 15 minutes.' : 'Wrong password.'), { type: 'text/html', admin: true });
}

export function logout(request) {
  if (!sameOrigin(request)) return send(403, 'Forbidden', { type: 'text/plain', admin: true });
  return send(303, '', { type: 'text/plain', headers: { Location: '/admin', 'Set-Cookie': `${COOKIE}=; Path=/admin; Max-Age=0; HttpOnly; SameSite=Strict` } });
}

export async function updateLead(request, env) {
  if (!sameOrigin(request) || request.headers.get('X-ILL-Admin') !== '1') return send(403, { error: 'forbidden' }, { admin: true });
  const data = parseJSON(await readBody(request, 16 * 1024));
  const id = Number(data && data.id);
  if (!data || !Number.isInteger(id)) return send(400, { error: 'bad request' }, { admin: true });
  const status = clean(data.status, 12), note = clean(data.note, 500);
  if (!STATUSES.includes(status)) return send(400, { error: 'bad status' }, { admin: true });
  await (await db(env)).prepare('UPDATE leads SET status = ?, note = ?, updated = ? WHERE id = ?').bind(status, note, now(), id).run();
  return send(200, { ok: true }, { admin: true });
}
export { parseJSON };

// ------------------------------------------------------------------------------------------ reporting
export async function summary(env, frm, to) {
  const t0 = dayStart(frm), t1 = dayStart(to) + 86400;
  const D = await db(env);
  const S = (await D.prepare('SELECT * FROM sessions WHERE started >= ? AND started < ? AND bot = 0').bind(t0, t1).all()).results;
  const L = (await D.prepare('SELECT * FROM leads WHERE ts >= ? AND ts < ? ORDER BY ts DESC').bind(t0, t1).all()).results;

  const lab = new Map(), ev = new Map(); // sid -> {"type:label": n}, sid -> {type: n}
  for (const s of S) {
    let c = {};
    try { c = JSON.parse(s.ev || '{}') || {}; } catch { c = {}; }
    const byType = {};
    for (const [k, n] of Object.entries(c)) { const ty = k.split(':')[0]; byType[ty] = (byType[ty] || 0) + (Number(n) || 0); }
    lab.set(s.id, c); ev.set(s.id, byType);
  }
  const leadSids = new Map();
  for (const l of L) if (l.status !== 'spam') leadSids.set(l.sid, (leadSids.get(l.sid) || 0) + 1);
  const realLeads = L.filter(l => l.status !== 'spam');

  const F = new Map();
  for (const s of S) {
    const e = ev.get(s.id);
    const f = { call: e.click_call > 0, copy: e.copy_phone > 0, wa: e.click_whatsapp > 0, form: e.form_start > 0, lead: leadSids.has(s.id) };
    f.interacted = INTERACTIVE.some(t => e[t]) || f.lead;
    f.engaged = f.interacted || (s.engaged_ms || 0) >= ENGAGED_MS || (s.max_scroll || 0) >= 50;
    f.contact = f.call || f.copy || f.wa || f.lead;
    F.set(s.id, f);
  }
  const n = S.length;
  const block = rows => {
    const k = rows.length, fl = rows.map(r => F.get(r.id));
    const eng = fl.filter(f => f.engaged).length;
    const times = rows.map(r => r.engaged_ms || 0).sort((a, b) => a - b);
    return {
      sessions: k, visitors: new Set(rows.map(r => r.visitor)).size, bounce_rate: pct(k - eng, k),
      median_time_s: Math.round((k ? times[Math.floor(k / 2)] : 0) / 1000),
      leads: rows.reduce((a, r) => a + (leadSids.get(r.id) || 0), 0),
      calls: fl.filter(f => f.call).length, copies: fl.filter(f => f.copy).length, whatsapp: fl.filter(f => f.wa).length,
      contact_rate: pct(fl.filter(f => f.contact).length, k),
    };
  };
  const totals = block(S);
  totals.returning = S.filter(s => s.is_return).length;
  totals.call_clicks = S.reduce((a, s) => a + (ev.get(s.id).click_call || 0), 0);
  totals.form_starts = S.filter(s => F.get(s.id).form).length;
  totals.form_abandons = S.filter(s => F.get(s.id).form && !F.get(s.id).lead).length;
  totals.form_abandon_rate = pct(totals.form_abandons, totals.form_starts);
  totals.leads = realLeads.length; // includes leads whose visit started before the range

  const Fv = [...F.values()];
  const funnel = [
    { step: 'Visited', n },
    { step: 'Engaged', n: Fv.filter(f => f.engaged).length },
    { step: 'Started the form', n: totals.form_starts },
    { step: 'Submitted a lead', n: Fv.filter(f => f.lead).length },
  ];
  const has = (s, k) => (lab.get(s.id)[k] || 0) > 0;
  const form = {
    started: totals.form_starts,
    touched_pin: S.filter(s => has(s, 'form_field:pin')).length,
    touched_phone: S.filter(s => has(s, 'form_field:phone')).length,
    error_pin: S.filter(s => has(s, 'form_error:pin')).length,
    error_phone: S.filter(s => has(s, 'form_error:phone')).length,
    submitted: Fv.filter(f => f.lead && f.form).length,
    abandoned: totals.form_abandons,
  };

  const group = (rows, keyFn) => {
    const m = new Map();
    for (const r of rows) { const k = keyFn(r); if (k === null) continue; const ks = JSON.stringify(k); if (!m.has(ks)) m.set(ks, [k, []]); m.get(ks)[1].push(r); }
    return [...m.values()];
  };
  const bySessions = (a, b) => b.sessions - a.sessions;
  const sources = group(S, sourceOf).map(([[source, medium], v]) => ({ source, medium, ...block(v) })).sort(bySessions);
  const campaigns = group(S, s => (s.utm_campaign ? [s.utm_campaign, sourceOf(s)[0]] : null))
    .map(([[campaign, source], v]) => ({ campaign, source, ...block(v) })).sort(bySessions);
  const devices = group(S, s => s.device || 'unknown').map(([device, v]) => ({ device, ...block(v) })).sort(bySessions);

  const days = [];
  for (let d = t0; d < t1; d += 86400) days.push(istDay(d));
  const daily = new Map(days.map(k => [k, { date: k, sessions: 0, leads: 0, calls: 0, whatsapp: 0 }]));
  for (const s of S) {
    const r = daily.get(istDay(s.started));
    if (r) { r.sessions++; if (F.get(s.id).call) r.calls++; if (F.get(s.id).wa) r.whatsapp++; }
  }
  for (const l of realLeads) { const r = daily.get(istDay(l.ts)); if (r) r.leads++; }

  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, sessions: 0, contacts: 0 }));
  for (const s of S) {
    const h = new Date((s.started + IST) * 1000).getUTCHours();
    hours[h].sessions++; if (F.get(s.id).contact) hours[h].contacts++;
  }

  const labelCounts = typ => {
    const c = new Map();
    for (const s of S) {
      for (const [k, v] of Object.entries(lab.get(s.id))) {
        if (k.startsWith(typ + ':') && Number(v) > 0) { const l = k.slice(typ.length + 1) || 'other'; c.set(l, (c.get(l) || 0) + 1); }
      }
    }
    return [...c].map(([l, sessions]) => ({ label: l, sessions })).sort((a, b) => b.sessions - a.sessions);
  };
  const sections = new Map(labelCounts('section_view').map(r => [r.label, r.sessions]));
  const order = [['sectors', 'Sectors'], ['compare', 'Leased line vs broadband'], ['benefits', 'What you get'],
    ['how', 'Live in three moves'], ['why', 'Scale'], ['testimonials', 'Client stories'], ['cta', 'Final call to action']];
  const reach = order.map(([id, l]) => ({ id, label: l, sessions: sections.get(id) || 0, pct: pct(sections.get(id) || 0, n) }));

  const leads = L.slice(0, 2000).map(l => ({ id: l.id, ts: l.ts, phone: l.phone, pin: l.pin, status: l.status, note: l.note,
    source: l.source, medium: l.medium, campaign: l.campaign, device: l.device }));

  return {
    range: { from: frm, to }, generated: now(), totals, funnel, form, daily: days.map(k => daily.get(k)), hours,
    sources, campaigns, devices, call_placements: labelCounts('click_call'), quote_placements: labelCounts('click_quote'),
    sectors: labelCounts('sector_open'), reach, leads,
  };
}

// Spreadsheet apps run a cell starting with = + - @ (or tab / CR) as a formula; UTM tags and notes come from outsiders.
const cell = v => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
export async function exportCsv(env, frm, to) {
  const rows = (await (await db(env)).prepare('SELECT * FROM leads WHERE ts >= ? AND ts < ? ORDER BY ts DESC')
    .bind(dayStart(frm), dayStart(to) + 86400).all()).results;
  const out = [['Received (IST)', 'Mobile (+91)', 'PIN code', 'Status', 'Note', 'Source', 'Medium', 'Campaign', 'Device']];
  for (const r of rows) {
    out.push([new Date((r.ts + IST) * 1000).toISOString().slice(0, 16).replace('T', ' '), r.phone, r.pin, r.status,
      r.note || '', r.source, r.medium, r.campaign, r.device]);
  }
  return '﻿' + out.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
