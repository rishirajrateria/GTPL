// Leads, visitor activity and the /admin dashboard for ill.gtplkcbpl.com on Cloudflare Pages.
// A port of server/ill_backend.py (the self-hosted version) to Pages Functions + D1.
//
// Bindings (Pages project -> Settings -> Bindings / Variables and secrets):
//   DB              D1 database (required)
//   ADMIN_PASSWORD  secret, at least 10 characters (required). Changing it signs everyone out.
//
// Built for the free plan:
// - 10 ms CPU per request: the dashboard's aggregation runs inside D1 (SQL), not in the Worker.
// - 100,000 D1 rows written a day, shared by tracking and leads: a visit is one row with its counters
//   in a JSON column; heartbeats that change nothing write nothing; tracking stops for the rest of the
//   UTC day at TRACKING_WRITE_BUDGET rows so the remainder is kept for leads.
import ADMIN_HTML from '../../server/admin.html';

const IST = 19800; // UTC+5:30, no daylight saving
const SID_RE = /^[a-z0-9]{8,40}$/;
const PHONE_RE = /^[6-9]\d{9}$/;
const PIN_RE = /^[1-9]\d{5}$/;
const BOT_RE = /bot|crawl|spider|slurp|preview|headless|lighthouse|pingdom|monitor|curl|wget|python-requests|facebookexternalhit|whatsapp/i;

// Events the page reports, each with the only labels it can carry (anything else is stored as "other").
const PLACES = ['nav', 'mobile_bar', 'final_cta', 'footer', 'hero', 'side_tab', 'page'];
const SECTIONS = ['sectors', 'compare', 'benefits', 'how', 'why', 'testimonials', 'cta'];
const SECTORS = ['it', 'telecom', 'health', 'edu', 'retail', 'mfg', 'auto', 'gov', 'media', 'logi', 'trade', 'food',
  'bfsi', 'realty', 'hosp', 'pro', 'energy']; // keys from data/build_sectors.py GROUPS
const EVENT_LABELS = {
  view: [''], click_call: PLACES, click_whatsapp: PLACES, click_quote: PLACES, copy_phone: ['selection'],
  form_start: [''], form_field: ['pin', 'phone'], form_error: ['pin', 'phone'], sector_open: SECTORS,
  section_view: SECTIONS, scroll: ['25', '50', '75', '90'],
};
const INTERACTIVE = ['click_call', 'copy_phone', 'click_whatsapp', 'click_quote', 'form_start', 'form_field',
  'form_error', 'sector_open'];
export const STATUSES = ['new', 'contacted', 'qualified', 'won', 'lost', 'spam'];
const ENGAGED_MS = 10000;
const RETENTION_DAYS = 400;            // visits older than this are deleted; leads are kept
const MAX_HEARTBEATS_PER_VISIT = 40;   // writes without new events; a tab left open stops costing writes
const MAX_KEYS_PER_FLUSH = 15;         // json_set takes 1 + 2 * keys arguments; D1 allows 32 per function
const TRACKING_WRITE_BUDGET = 60000;   // D1 rows/day tracking may use; the rest of the 100k is kept for leads
const NEW_VISITS_PER_IP = 20;          // per 10 minutes, per isolate
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
     ev TEXT DEFAULT '{}', beats INTEGER DEFAULT 0, src TEXT DEFAULT '', med TEXT DEFAULT '')`,
  'CREATE INDEX IF NOT EXISTS sessions_started ON sessions(started)',
  `CREATE TABLE IF NOT EXISTS leads(
     id INTEGER PRIMARY KEY, ts REAL, sid TEXT, phone TEXT, pin TEXT,
     status TEXT DEFAULT 'new', note TEXT DEFAULT '', updated REAL,
     source TEXT DEFAULT '', medium TEXT DEFAULT '', campaign TEXT DEFAULT '', device TEXT DEFAULT '', ref_host TEXT DEFAULT '')`,
  'CREATE INDEX IF NOT EXISTS leads_ts ON leads(ts)',
  'CREATE INDEX IF NOT EXISTS leads_phone ON leads(phone)',
  'CREATE INDEX IF NOT EXISTS leads_sid ON leads(sid)',
  'CREATE TABLE IF NOT EXISTS throttle(k TEXT PRIMARY KEY, n INTEGER, reset REAL)',
  'CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)',
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
const HTTPS_HEADERS = { 'Strict-Transport-Security': 'max-age=31536000' }; // _headers does not reach Functions
const ADMIN_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
};
export function send(status, body = '', { type = 'application/json', admin = false, headers = {} } = {}) {
  if (body !== null && typeof body === 'object') body = JSON.stringify(body);
  const h = { ...BASE_HEADERS, ...HTTPS_HEADERS, ...(admin ? ADMIN_HEADERS : {}), ...headers };
  if (body !== '' && body !== null) h['Content-Type'] = type + (/^(text|application\/json)/.test(type) ? '; charset=utf-8' : '');
  return new Response(status === 204 ? null : body, { status, headers: h });
}

/** Client address for rate limits: IPv4 as is, IPv6 by its /64 (one phone or home line gets a whole /64). */
export function ipKey(request) {
  const a = (request.headers.get('CF-Connecting-IP') || '0.0.0.0').toLowerCase();
  if (!a.includes(':')) return a;
  const [h, t = ''] = a.split('::');
  const head = h ? h.split(':') : [], tail = t ? t.split(':') : [];
  const full = [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  return full.slice(0, 4).map(x => (parseInt(x, 16) || 0).toString(16)).join(':') + '::/64';
}

/** Requests from another site's page carry its Origin; same-origin and non-browser requests pass.
 *  A browser sends "Origin: null" for some same-site form posts, so then its Sec-Fetch-Site decides. */
export function sameOrigin(request) {
  const o = request.headers.get('Origin');
  if (!o) return true;
  if (o === 'null') return request.headers.get('Sec-Fetch-Site') === 'same-origin';
  try { return new URL(o).host === new URL(request.url).host; } catch { return false; }
}

/** The body as text, or null once it passes `limit` bytes (read in chunks, so a huge upload is never held). */
export async function readBody(request, limit) {
  if (Number(request.headers.get('Content-Length') || 0) > limit) return null;
  const reader = request.body && request.body.getReader();
  if (!reader) return '';
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > limit) { await reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const buf = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.byteLength; }
  return new TextDecoder().decode(buf);
}
export const parseJSON = s => {
  if (s === null) return null;
  try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
};

// Fixed-window counter in D1, shared by every Cloudflare location. Counts the hit first and decides on the
// returned value, so parallel requests cannot all slip past; hits already over the limit write nothing.
async function throttleHit(env, key, limit, windowS) {
  const t = now();
  const row = await (await db(env)).prepare(
    `INSERT INTO throttle(k, n, reset) VALUES(?1, 1, ?2)
     ON CONFLICT(k) DO UPDATE SET n = CASE WHEN reset <= ?3 THEN 1 ELSE n + 1 END,
                                  reset = CASE WHEN reset <= ?3 THEN ?2 ELSE reset END
       WHERE throttle.n <= ?4 OR throttle.reset <= ?3
     RETURNING n`).bind(key, t + windowS, t, limit).first();
  return !!row && row.n <= limit;
}

// Per-isolate limits for the activity endpoint (memory is free; D1 writes are the scarce resource).
const windows = new Map();
function windowHit(key, limit, ms, count = true) {
  const t = Date.now();
  let w = windows.get(key);
  if (!w || t - w.start > ms) { w = { start: t, n: 0 }; windows.set(key, w); if (windows.size > 20000) windows.clear(); }
  if (w.n >= limit) return false;
  if (count) w.n++;
  return true;
}

// Daily tracking budget: rows written are tallied per isolate and added to a shared per-UTC-day counter
// every 100 rows (one extra write per 100). Past the budget, tracking stops until 00:00 UTC.
const budget = { day: '', rows: 0, off: false };
async function trackingSpent(D, rows) {
  const day = new Date().toISOString().slice(0, 10);
  if (budget.day !== day) Object.assign(budget, { day, rows: 0, off: false });
  budget.rows += rows;
  if (budget.rows < 100) return;
  const add = budget.rows;
  budget.rows = 0;
  const row = await D.prepare(`INSERT INTO throttle(k, n, reset) VALUES(?1, ?2, ?3)
      ON CONFLICT(k) DO UPDATE SET n = n + excluded.n RETURNING n`)
    .bind('track:' + day, add, now() + 2 * 86400).first();
  if (row && row.n >= TRACKING_WRITE_BUDGET) budget.off = true;
}
const trackingOff = () => budget.off && budget.day === new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------------------------------------ auth
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(String(s))));

// The cookie is signed with a random key kept in D1 plus a hash of the password: a stolen cookie
// cannot be used to guess the password offline, and changing the password signs everyone out.
let keyCache = null;
async function hmacKey(env) {
  const pw = await sha256(env.ADMIN_PASSWORD);
  if (keyCache && keyCache.pw === pw) return keyCache.key;
  const D = await db(env);
  await D.prepare('INSERT OR IGNORE INTO meta(k, v) VALUES(?, ?)').bind('cookie_key', hex(crypto.getRandomValues(new Uint8Array(32)))).run();
  const { v } = await D.prepare('SELECT v FROM meta WHERE k = ?').bind('cookie_key').first();
  const key = await crypto.subtle.importKey('raw', enc.encode(v + ':' + pw), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  keyCache = { pw, key };
  return key;
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

/** /admin answers only on the site's own addresses, not on old per-deployment URLs
 *  (<hash>.<project>.pages.dev keep the password they were deployed with). */
export function adminHostOk(request) {
  const host = new URL(request.url).hostname;
  return host === 'localhost' || host === '127.0.0.1' || /(^|\.)gtplkcbpl\.com$/.test(host) || /^[a-z0-9-]+\.pages\.dev$/.test(host);
}
export async function authed(request, env) {
  if (!passwordConfigured(env) || !adminHostOk(request)) return false;
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
  if (!SID_RE.test(sid) || !SID_RE.test(vid) || BOT_RE.test(ua) || trackingOff()) return;
  const ipk = ipKey(request);
  const t = now();
  const meta = data.meta && typeof data.meta === 'object' ? data.meta : null;
  const eng = data.eng && typeof data.eng === 'object' ? data.eng : {};
  const ms = Math.max(0, Math.min(parseInt(eng.ms, 10) || 0, 6 * 3600 * 1000));
  const sc = Math.max(0, Math.min(parseInt(eng.sc, 10) || 0, 100));
  const counts = {};
  for (const e of Array.isArray(data.ev) ? data.ev.slice(0, 60) : []) {
    if (!e || typeof e !== 'object') continue;
    const type = clean(e.t, 20);
    if (!EVENT_LABELS[type]) continue;
    const l = clean(e.l, 40);
    const k = type + ':' + (EVENT_LABELS[type].includes(l) ? l : 'other');
    counts[k] = (counts[k] || 0) + 1;
  }
  const keys = Object.keys(counts).slice(0, MAX_KEYS_PER_FLUSH);
  const D = await db(env);
  let written = 0;

  // The tracker repeats `meta` on every flush, so a visit whose first request was lost is still created.
  // New visits per address are capped (per isolate) so a script cannot mint them by the thousand.
  if (meta && windowHit('new:' + ipk, NEW_VISITS_PER_IP, 600000, false)) {
    const { device, browser, os } = parseUA(ua);
    let ref = clean(meta.ref, 120).toLowerCase();
    if (ref.startsWith('ill.') && ref.endsWith('gtplkcbpl.com')) ref = '';
    const row = {
      utm_source: clean(meta.us, 80), utm_medium: clean(meta.um, 80), utm_campaign: clean(meta.uc, 120),
      click_id: { g: 'gclid', f: 'fbclid', m: 'msclkid' }[clean(meta.ck, 2)] || '', ref_host: ref,
    };
    const [src, med] = sourceOf(row);
    const ev = JSON.stringify(Object.fromEntries(keys.map(k => [k, counts[k]])));
    const res = await D.prepare(
      `INSERT OR IGNORE INTO sessions(id, visitor, is_return, started, last, ref_host, utm_source, utm_medium, utm_campaign,
         utm_term, utm_content, click_id, device, browser, os, lang, screen, engaged_ms, max_scroll, ev, src, med)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      sid, vid, meta.ret ? 1 : 0, t, t, ref, row.utm_source, row.utm_medium, row.utm_campaign,
      clean(meta.ut, 120), clean(meta.ux, 120), row.click_id, device, browser, os, clean(meta.lang, 12), clean(meta.scr, 12),
      ms, sc, ev, src.slice(0, 80), med.slice(0, 80)).run();
    if (res.meta.changes) {
      windowHit('new:' + ipk, NEW_VISITS_PER_IP, 600000);
      await trackingSpent(D, res.meta.rows_written || 3);
      if (Math.random() < 0.01) await prune(D);
      return;
    }
  }
  // Merge counters atomically: json_set(ev, path1, old1 + n1, ...). A flush with no new events writes only
  // when it matters (engagement crossed 10 s or grew 15 s, scroll grew, or the visitor is leaving with more
  // time to record), and at most MAX_HEARTBEATS_PER_VISIT times.
  // Numbered parameters: ?1 ms, ?2 scroll, ?3 now, ?4 sid, ?5 vid, ?6 has events, ?7 heartbeat cap,
  // ?8 final flush, ?9 heartbeat increment, then three per event key.
  const args = [ms, sc, t, sid, vid, keys.length ? 1 : 0, MAX_HEARTBEATS_PER_VISIT, data.fin ? 1 : 0, keys.length ? 0 : 1];
  let expr = 'ev';
  if (keys.length) {
    const parts = keys.map(k => {
      args.push(`$."${k}"`, counts[k]);
      const p = args.length - 1, c = args.length;
      return `?${p}, CAST(COALESCE(json_extract(ev, ?${p}), 0) + ?${c} AS INTEGER)`;
    });
    expr = `json_set(ev, ${parts.join(', ')})`;
  }
  const res = await D.prepare(
    `UPDATE sessions SET last = ?3, engaged_ms = MAX(engaged_ms, ?1), max_scroll = MAX(max_scroll, ?2), ev = ${expr},
       beats = beats + ?9
     WHERE id = ?4 AND visitor = ?5 AND bot = 0 AND length(ev) < 4000
       AND (?6 OR (beats < ?7 AND (?1 >= engaged_ms + 15000 OR (?1 >= ${ENGAGED_MS} AND engaged_ms < ${ENGAGED_MS})
                                  OR ?2 > max_scroll OR (?8 AND ?1 > engaged_ms + 1000))))`).bind(...args).run();
  written = res.meta.rows_written || res.meta.changes || 0;
  if (written) await trackingSpent(D, written);
}

// Run on about 1 in 100 new visits: old visits and expired counters go, a bounded number at a time.
async function prune(D) {
  const t = now();
  await D.batch([
    D.prepare('DELETE FROM sessions WHERE rowid IN (SELECT rowid FROM sessions WHERE started < ? LIMIT 500)').bind(t - RETENTION_DAYS * 86400),
    D.prepare('DELETE FROM throttle WHERE rowid IN (SELECT rowid FROM throttle WHERE reset < ? LIMIT 500)').bind(t),
  ]);
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
  if (!(Number(data.t) >= 2500)) return markBot(env, sid); // missing, or faster than a person can type
  const D = await db(env);
  const s = SID_RE.test(sid) ? await D.prepare('SELECT * FROM sessions WHERE id = ?').bind(sid).first() : null;
  let src = '(unknown)', med = '(unknown)', camp = '', dev = parseUA(ua).device, ref = '';
  if (s) { src = s.src || sourceOf(s)[0]; med = s.med || sourceOf(s)[1]; camp = s.utm_campaign; dev = s.device; ref = s.ref_host; }
  const t = now();
  // One statement, so two submissions at the same moment cannot both pass the "same number in the last hour" check.
  await D.prepare(`INSERT INTO leads(ts, sid, phone, pin, source, medium, campaign, device, ref_host, updated)
                   SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM leads WHERE phone = ? AND ts > ?)`)
    .bind(t, sid, phone, pin, src, med, camp, dev, ref, t, phone, t - 3600).run();
  return { ok: true };
}
export const leadAllowed = (env, request) => throttleHit(env, 'lead:' + ipKey(request), 6, 600);
export const eventsAllowed = request => windowHit('ev:' + ipKey(request), 240, 60000);

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
const WRONG_HOST = loginPage('Open the dashboard on the site’s own address, for example https://ill.gtplkcbpl.com/admin.');
const html = (status, body) => send(status, body, { type: 'text/html', admin: true });

export async function adminPage(request, env) {
  if (!adminHostOk(request)) return html(404, WRONG_HOST);
  if (!passwordConfigured(env)) return html(200, NOT_SET_UP);
  if (!(await authed(request, env))) return html(200, loginPage());
  return html(200, ADMIN_HTML);
}

export async function login(request, env) {
  if (!sameOrigin(request)) return send(403, 'Forbidden', { type: 'text/plain', admin: true });
  if (!adminHostOk(request)) return html(404, WRONG_HOST);
  if (!passwordConfigured(env)) return html(503, NOT_SET_UP);
  const key = 'login:' + ipKey(request);
  // Count the attempt before checking it; if the counter cannot be written, refuse (fail closed).
  let allowed = false;
  try { allowed = await throttleHit(env, key, 5, 900); } catch (e) { console.error('login throttle:', e.message); }
  if (!allowed) return html(429, loginPage('Too many attempts. Try again in 15 minutes.'));
  const pw = new URLSearchParams((await readBody(request, 4096)) || '').get('password') || '';
  if (await passwordOk(env, pw)) {
    await (await db(env)).prepare('DELETE FROM throttle WHERE k = ?').bind(key).run().catch(() => {});
    const cookie = `${COOKIE}=${await makeToken(env)}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${COOKIE_TTL}` + (isHttps(request) ? '; Secure' : '');
    return send(303, '', { type: 'text/plain', headers: { Location: '/admin', 'Set-Cookie': cookie } });
  }
  return html(401, loginPage('Wrong password.'));
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

// ------------------------------------------------------------------------------------------ reporting
// All per-visit work happens in D1; the Worker only shapes a few hundred aggregated rows, which keeps it
// inside the free plan's 10 ms CPU. One statement computes every grouping from one pass over the visits.
const has = type => `(ev LIKE '%"${type}:%')`;
const VISITS = `
  v AS MATERIALIZED (
    SELECT s.id, s.visitor, s.is_return, s.started, s.engaged_ms, s.max_scroll, s.device, s.utm_campaign AS camp,
           s.src, s.med, s.utm_source, s.utm_medium, s.click_id, s.ref_host,
           ${has('click_call')} AS call, ${has('copy_phone')} AS copy, ${has('click_whatsapp')} AS wa,
           ${has('form_start')} AS form, (${INTERACTIVE.map(has).join(' OR ')}) AS inter,
           (SELECT COUNT(*) FROM leads l WHERE l.sid = s.id AND l.status != 'spam') AS nleads
    FROM sessions s WHERE s.started >= ?1 AND s.started < ?2 AND s.bot = 0),
  f AS MATERIALIZED (
    SELECT *, nleads > 0 AS lead, (inter OR nleads > 0 OR engaged_ms >= ${ENGAGED_MS} OR max_scroll >= 50) AS engaged,
           (call OR copy OR wa OR nleads > 0) AS contact
    FROM v)`;
const BLOCK = `COUNT(*) AS sessions, COUNT(DISTINCT visitor) AS visitors, SUM(NOT engaged) AS bounced,
  SUM(nleads) AS leads, SUM(call) AS calls, SUM(copy) AS copies, SUM(wa) AS whatsapp, SUM(contact) AS contacts,
  SUM(is_return) AS ret, SUM(form) AS form_starts, SUM(form AND NOT lead) AS abandons, SUM(lead) AS lead_visits,
  SUM(lead AND form) AS lead_form, 0 AS median`;
const MEDIAN = (cols, kind) => `
  SELECT '${kind}' AS kind, ${cols.length ? cols.map((c, i) => `${c} AS ${'ab'[i]}`).join(', ') : "'' AS a"}${cols.length < 2 ? ", '' AS b" : ''},
         0,0,0,0,0,0,0,0,0,0,0,0,0, engaged_ms
  FROM (SELECT ${cols.length ? cols.join(', ') + ',' : ''} engaged_ms,
               ROW_NUMBER() OVER (${cols.length ? 'PARTITION BY ' + cols.join(', ') : ''} ORDER BY engaged_ms) AS rn,
               COUNT(*) OVER (${cols.length ? 'PARTITION BY ' + cols.join(', ') : ''}) AS cnt
        FROM f${kind === 'med_camp' ? " WHERE camp != ''" : ''})
  WHERE rn = cnt / 2 + 1`;
// D1 allows only a few SELECTs per compound statement, so the groupings are split across two statements.
const SUMMARY_SQL = [`WITH ${VISITS}
  SELECT 'total' AS kind, '' AS a, '' AS b, ${BLOCK} FROM f
  UNION ALL SELECT 'src', src, med, ${BLOCK} FROM f GROUP BY src, med
  UNION ALL SELECT 'camp', camp, src, ${BLOCK} FROM f WHERE camp != '' GROUP BY camp, src
  UNION ALL SELECT 'dev', device, '', ${BLOCK} FROM f GROUP BY device
  UNION ALL SELECT 'day', strftime('%Y-%m-%d', started + ${IST}, 'unixepoch'), '', ${BLOCK} FROM f GROUP BY 2`,
`WITH ${VISITS}
  SELECT 'hour' AS kind, strftime('%H', started + ${IST}, 'unixepoch') AS a, '' AS b, ${BLOCK} FROM f GROUP BY 2
  UNION ALL ${MEDIAN([], 'med_total')}
  UNION ALL ${MEDIAN(['src', 'med'], 'med_src')}
  UNION ALL ${MEDIAN(['camp', 'src'], 'med_camp')}
  UNION ALL ${MEDIAN(['device'], 'med_dev')}`];
const LABELS_SQL = `SELECT j.key AS k, COUNT(*) AS visits, SUM(j.value) AS total
  FROM sessions s, json_each(s.ev) AS j
  WHERE s.started >= ?1 AND s.started < ?2 AND s.bot = 0 AND j.value > 0 GROUP BY j.key`;

export async function summary(env, frm, to) {
  const t0 = dayStart(frm), t1 = dayStart(to) + 86400;
  const D = await db(env);
  const [aggA, aggB, labs, ldays, leadRows] = await D.batch([
    D.prepare(SUMMARY_SQL[0]).bind(t0, t1),
    D.prepare(SUMMARY_SQL[1]).bind(t0, t1),
    D.prepare(LABELS_SQL).bind(t0, t1),
    D.prepare(`SELECT strftime('%Y-%m-%d', ts + ${IST}, 'unixepoch') AS d, COUNT(*) AS n FROM leads
               WHERE ts >= ? AND ts < ? AND status != 'spam' GROUP BY d`).bind(t0, t1),
    D.prepare(`SELECT id, ts, phone, pin, status, note, source, medium, campaign, device FROM leads
               WHERE ts >= ? AND ts < ? ORDER BY ts DESC LIMIT 1000`).bind(t0, t1),
  ]);
  const rows = [...aggA.results, ...aggB.results];
  const pick = kind => rows.filter(r => r.kind === kind);
  const medians = {};
  for (const r of rows) if (r.kind.startsWith('med_')) medians[`${r.kind.slice(4)}|${r.a}|${r.b}`] = r.median;
  const block = (r, medKey) => ({
    sessions: r.sessions, visitors: r.visitors, bounce_rate: pct(r.bounced, r.sessions),
    median_time_s: Math.round((medians[medKey] || 0) / 1000), leads: r.leads || 0, calls: r.calls || 0,
    copies: r.copies || 0, whatsapp: r.whatsapp || 0, contact_rate: pct(r.contacts, r.sessions),
  });
  const total = pick('total')[0];
  const n = total.sessions;
  const label = new Map(labs.results.map(r => [r.k, r]));
  const visitsWith = k => (label.get(k) || { visits: 0 }).visits;
  const realLeads = ldays.results.reduce((a, r) => a + r.n, 0);

  const totals = block(total, 'total||');
  Object.assign(totals, {
    returning: total.ret || 0,
    call_clicks: labs.results.filter(r => r.k.startsWith('click_call:')).reduce((a, r) => a + r.total, 0),
    form_starts: total.form_starts || 0, form_abandons: total.abandons || 0,
    form_abandon_rate: pct(total.abandons, total.form_starts), leads: realLeads, // includes leads whose visit started earlier
  });
  const funnel = [
    { step: 'Visited', n }, { step: 'Engaged', n: n - (total.bounced || 0) },
    { step: 'Started the form', n: totals.form_starts }, { step: 'Submitted a lead', n: total.lead_visits || 0 },
  ];
  const form = {
    started: totals.form_starts, touched_pin: visitsWith('form_field:pin'), touched_phone: visitsWith('form_field:phone'),
    error_pin: visitsWith('form_error:pin'), error_phone: visitsWith('form_error:phone'),
    submitted: total.lead_form || 0, abandoned: totals.form_abandons,
  };
  const top = (list, n2 = 25) => list.sort((a, b) => b.sessions - a.sessions).slice(0, n2);
  const sources = top(pick('src').map(r => ({ source: r.a, medium: r.b, ...block(r, `src|${r.a}|${r.b}`) })));
  const campaigns = top(pick('camp').map(r => ({ campaign: r.a, source: r.b, ...block(r, `camp|${r.a}|${r.b}`) })));
  const devices = top(pick('dev').map(r => ({ device: r.a || 'unknown', ...block(r, `dev|${r.a}|`) })));

  const days = [];
  for (let d = t0; d < t1; d += 86400) days.push(istDay(d));
  const dayRow = new Map(pick('day').map(r => [r.a, r]));
  const dayLeads = new Map(ldays.results.map(r => [r.d, r.n]));
  const daily = days.map(date => {
    const r = dayRow.get(date) || {};
    return { date, sessions: r.sessions || 0, leads: dayLeads.get(date) || 0, calls: r.calls || 0, whatsapp: r.whatsapp || 0 };
  });
  const hourRow = new Map(pick('hour').map(r => [Number(r.a), r]));
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, sessions: (hourRow.get(hour) || {}).sessions || 0, contacts: (hourRow.get(hour) || {}).contacts || 0 }));

  const labelCounts = typ => labs.results.filter(r => r.k.startsWith(typ + ':'))
    .map(r => ({ label: r.k.slice(typ.length + 1) || 'other', sessions: r.visits })).sort((a, b) => b.sessions - a.sessions);
  const order = [['sectors', 'Sectors'], ['compare', 'Leased line vs broadband'], ['benefits', 'What you get'],
    ['how', 'Live in three moves'], ['why', 'Scale'], ['testimonials', 'Client stories'], ['cta', 'Final call to action']];
  const reach = order.map(([id, l]) => ({ id, label: l, sessions: visitsWith('section_view:' + id), pct: pct(visitsWith('section_view:' + id), n) }));

  return {
    range: { from: frm, to }, generated: now(), totals, funnel, form, daily, hours, sources, campaigns, devices,
    call_placements: labelCounts('click_call'), quote_placements: labelCounts('click_quote'),
    sectors: labelCounts('sector_open'), reach, leads: leadRows.results,
  };
}

// Spreadsheet apps run a cell starting with = + - @ (or tab / CR) as a formula; UTM tags and notes come from outsiders.
const cell = v => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
export async function exportCsv(env, frm, to) {
  const rows = (await (await db(env)).prepare(`SELECT ts, phone, pin, status, note, source, medium, campaign, device
      FROM leads WHERE ts >= ? AND ts < ? ORDER BY ts DESC LIMIT 20000`).bind(dayStart(frm), dayStart(to) + 86400).all()).results;
  const out = [['Received (IST)', 'Mobile (+91)', 'PIN code', 'Status', 'Note', 'Source', 'Medium', 'Campaign', 'Device']];
  for (const r of rows) {
    out.push([new Date((r.ts + IST) * 1000).toISOString().slice(0, 16).replace('T', ' '), r.phone, r.pin, r.status,
      r.note || '', r.source, r.medium, r.campaign, r.device]);
  }
  return '﻿' + out.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
