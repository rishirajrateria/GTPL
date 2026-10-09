#!/usr/bin/env python3
"""
GTPL KCBPL leased line page: lead capture + visitor activity analytics + /admin dashboard.

Standard library only (Python 3.8+). Stores everything in one SQLite file.
Runs behind nginx/Apache, which proxy /api/ and /admin to it.

  python3 ill_backend.py hash-password      # print a password hash for ILL_ADMIN_PASSWORD_HASH
  python3 ill_backend.py secret             # print a random value for ILL_SECRET
  python3 ill_backend.py serve              # run the server (normally via systemd)

Environment (see ill-backend.env.example):
  ILL_ADMIN_PASSWORD_HASH   required  output of `hash-password`
  ILL_SECRET                required  long random string; signs admin login cookies
  ILL_DB                    optional  default /var/lib/ill-backend/ill.db
  ILL_HOST / ILL_PORT       optional  default 127.0.0.1:8787
  ILL_RETENTION_DAYS        optional  raw activity events older than this are deleted (default 400; leads are never deleted)
  ILL_SMTP_HOST, ILL_SMTP_PORT, ILL_SMTP_USER, ILL_SMTP_PASSWORD, ILL_SMTP_FROM, ILL_NOTIFY_TO, ILL_SMTP_STARTTLS
                            optional  e-mail an alert for every new lead
"""
import calendar, csv, getpass, hashlib, hmac, io, json, os, re, secrets, smtplib, sqlite3, sys, threading, time
from collections import defaultdict
from email.message import EmailMessage
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
IST = 19800  # UTC+5:30, no daylight saving
SID_RE = re.compile(r'^[a-z0-9]{8,40}$')
PHONE_RE = re.compile(r'^[6-9]\d{9}$')
PIN_RE = re.compile(r'^[1-9]\d{5}$')
BOT_RE = re.compile(r'bot|crawl|spider|slurp|preview|headless|lighthouse|pingdom|monitor|curl|wget|python-requests|facebookexternalhit|whatsapp', re.I)

# Activity the page may report. Anything else is ignored.
EVENT_TYPES = {
    'view', 'click_call', 'copy_phone', 'click_whatsapp', 'click_quote', 'form_start', 'form_field',
    'form_error', 'sector_open', 'section_view', 'scroll',
}
# Events that mean the visitor did something (used for bounce / engagement).
INTERACTIVE = {'click_call', 'copy_phone', 'click_whatsapp', 'click_quote', 'form_start', 'form_field',
               'form_error', 'sector_open'}
STATUSES = ('new', 'contacted', 'qualified', 'won', 'lost', 'spam')
ENGAGED_MS = 10_000  # a visit counts as engaged after 10 s of visible time, any interaction, or 50 % scroll


def env(name, default=None):
    v = os.environ.get(name)
    return v if v not in (None, '') else default


# ----------------------------------------------------------------------------------------------- storage
class Store:
    def __init__(self, path):
        d = os.path.dirname(path)
        if d:
            os.makedirs(d, exist_ok=True)
        self.path = path
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=NORMAL')
        self.db.executescript('''
        CREATE TABLE IF NOT EXISTS sessions(
          id TEXT PRIMARY KEY, visitor TEXT, is_return INTEGER DEFAULT 0, started REAL, last REAL,
          ref_host TEXT DEFAULT '', utm_source TEXT DEFAULT '', utm_medium TEXT DEFAULT '', utm_campaign TEXT DEFAULT '',
          utm_term TEXT DEFAULT '', utm_content TEXT DEFAULT '', click_id TEXT DEFAULT '',
          device TEXT DEFAULT '', browser TEXT DEFAULT '', os TEXT DEFAULT '', lang TEXT DEFAULT '', screen TEXT DEFAULT '',
          engaged_ms INTEGER DEFAULT 0, max_scroll INTEGER DEFAULT 0, bot INTEGER DEFAULT 0);
        CREATE INDEX IF NOT EXISTS sessions_started ON sessions(started);
        CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, sid TEXT, ts REAL, type TEXT, label TEXT DEFAULT '');
        CREATE INDEX IF NOT EXISTS events_sid ON events(sid);
        CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
        CREATE TABLE IF NOT EXISTS leads(
          id INTEGER PRIMARY KEY, ts REAL, sid TEXT, phone TEXT, pin TEXT,
          status TEXT DEFAULT 'new', note TEXT DEFAULT '', updated REAL,
          source TEXT DEFAULT '', medium TEXT DEFAULT '', campaign TEXT DEFAULT '', device TEXT DEFAULT '', ref_host TEXT DEFAULT '');
        CREATE INDEX IF NOT EXISTS leads_ts ON leads(ts);
        ''')

    def q(self, sql, args=()):
        with self.lock:
            return self.db.execute(sql, args).fetchall()

    def x(self, sql, args=()):
        with self.lock:
            cur = self.db.execute(sql, args)
            return cur.lastrowid

    def many(self, sql, rows):
        with self.lock:
            self.db.execute('BEGIN')
            try:
                self.db.executemany(sql, rows)
                self.db.execute('COMMIT')
            except Exception:
                self.db.execute('ROLLBACK')
                raise

    def prune(self, days):
        self.x('DELETE FROM events WHERE ts < ?', (time.time() - days * 86400,))


# ----------------------------------------------------------------------------------------------- helpers
def clean(v, n=120):
    v = '' if v is None else str(v)
    v = re.sub(r'[\x00-\x1f\x7f]', '', v).strip()
    return v[:n]


def parse_ua(ua):
    u = ua or ''
    if re.search(r'iPad|Tablet|(Android(?!.*Mobile))', u):
        device = 'tablet'
    elif re.search(r'Mobi|iPhone|Android', u):
        device = 'mobile'
    else:
        device = 'desktop'
    for name, pat in (('Edge', r'Edg/'), ('Samsung', r'SamsungBrowser'), ('Opera', r'OPR/|Opera'), ('Chrome', r'Chrome/|CriOS'),
                      ('Firefox', r'Firefox/|FxiOS'), ('Safari', r'Safari/')):
        if re.search(pat, u):
            browser = name
            break
    else:
        browser = 'Other'
    for name, pat in (('Android', r'Android'), ('iOS', r'iPhone|iPad|iPod'), ('Windows', r'Windows'), ('macOS', r'Mac OS X'), ('Linux', r'Linux')):
        if re.search(pat, u):
            osn = name
            break
    else:
        osn = 'Other'
    return device, browser, osn


AI_HOSTS = (('chatgpt.com', 'chatgpt'), ('chat.openai.com', 'chatgpt'), ('perplexity.ai', 'perplexity'), ('gemini.google.com', 'gemini'),
            ('claude.ai', 'claude'), ('copilot.microsoft.com', 'copilot'))
SOCIAL = (('facebook', 'facebook'), ('fb', 'facebook'), ('instagram', 'instagram'), ('linkedin', 'linkedin'), ('lnkd.in', 'linkedin'),
          ('t.co', 'x'), ('twitter', 'x'), ('x.com', 'x'), ('whatsapp', 'whatsapp'), ('wa.me', 'whatsapp'), ('youtube', 'youtube'),
          ('reddit', 'reddit'))
SEARCH = ('google.', 'bing.', 'yahoo.', 'duckduckgo.', 'ecosia.', 'yandex.')


def source_of(s):
    """(source, medium) for a session, the way an ads team reads it."""
    if s['utm_source']:
        return s['utm_source'].lower(), (s['utm_medium'] or '(not set)').lower()
    if s['click_id'] == 'gclid':
        return 'google', 'cpc'
    if s['click_id'] == 'fbclid':
        return 'facebook', 'social'
    if s['click_id'] == 'msclkid':
        return 'bing', 'cpc'
    ref = (s['ref_host'] or '').lower()
    if not ref:
        return '(direct)', '(none)'
    for h, name in AI_HOSTS:
        if h in ref:
            return name, 'ai-assistant'
    for h in SEARCH:
        if ref.startswith(h) or ('.' + h) in ref:
            return h.rstrip('.'), 'organic'
    for h, name in SOCIAL:
        if ref == h or ref.startswith(h + '.') or ('.' + h + '.') in ref or ref.endswith('.' + h):
            return name, 'social'
    return (ref[4:] if ref.startswith('www.') else ref), 'referral'


def ist_day(ts):
    return time.strftime('%Y-%m-%d', time.gmtime(ts + IST))


def day_start(s):
    """'YYYY-MM-DD' in IST -> UTC epoch seconds of that IST midnight."""
    return float(calendar.timegm(time.strptime(s, '%Y-%m-%d'))) - IST


# ----------------------------------------------------------------------------------------------- auth
def hash_password(pw, iters=240_000):
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac('sha256', pw.encode(), salt.encode(), iters)
    return f'pbkdf2_sha256:{iters}:{salt}:{dk.hex()}'  # no '$': env files and shells would expand it


def check_password(pw, stored):
    try:
        algo, iters, salt, hexd = re.split(r'[:$]', stored.strip())
        assert algo == 'pbkdf2_sha256'
        dk = hashlib.pbkdf2_hmac('sha256', pw.encode(), salt.encode(), int(iters))
        return hmac.compare_digest(dk.hex(), hexd)
    except Exception:
        return False


class Auth:
    TTL = 12 * 3600

    def __init__(self, secret, pw_hash):
        self.key = hashlib.sha256(('ill-admin:' + secret).encode()).digest()
        self.pw_hash = pw_hash
        self.fails = defaultdict(list)

    def token(self):
        exp = int(time.time()) + self.TTL
        body = f'{exp}.{secrets.token_hex(8)}'
        sig = hmac.new(self.key, body.encode(), 'sha256').hexdigest()
        return f'{body}.{sig}'

    def valid(self, tok):
        try:
            exp, nonce, sig = tok.split('.')
            good = hmac.new(self.key, f'{exp}.{nonce}'.encode(), 'sha256').hexdigest()
            return hmac.compare_digest(good, sig) and int(exp) > time.time()
        except Exception:
            return False

    def locked(self, ip):
        now = time.time()
        self.fails[ip] = [t for t in self.fails[ip] if now - t < 900]
        return len(self.fails[ip]) >= 5

    def attempt(self, ip, pw):
        if self.locked(ip):
            return False
        ok = check_password(pw, self.pw_hash)
        if not ok:
            self.fails[ip].append(time.time())
        return ok


class RateLimit:
    def __init__(self, n, window):
        self.n, self.w, self.hits, self.lock = n, window, defaultdict(list), threading.Lock()

    def allow(self, key):
        now = time.time()
        with self.lock:
            h = [t for t in self.hits[key] if now - t < self.w]
            if len(h) >= self.n:
                self.hits[key] = h
                return False
            h.append(now)
            self.hits[key] = h
            if len(self.hits) > 50_000:  # keep memory bounded
                self.hits.clear()
            return True


# ----------------------------------------------------------------------------------------------- lead e-mail
def notify_lead(lead):
    host, to = env('ILL_SMTP_HOST'), env('ILL_NOTIFY_TO')
    if not host or not to:
        return
    try:
        msg = EmailMessage()
        msg['Subject'] = f"New leased line lead: {lead['phone']} (PIN {lead['pin']})"
        msg['From'] = env('ILL_SMTP_FROM', env('ILL_SMTP_USER', 'noreply@gtplkcbpl.com'))
        msg['To'] = to
        msg.set_content(
            f"New enquiry from ill.gtplkcbpl.com\n\n"
            f"Phone:    +91 {lead['phone']}\nPIN code: {lead['pin']}\n"
            f"Source:   {lead['source']} / {lead['medium']}{(' / ' + lead['campaign']) if lead['campaign'] else ''}\n"
            f"Device:   {lead['device']}\nTime:     {time.strftime('%d %b %Y, %I:%M %p IST', time.gmtime(lead['ts'] + IST))}\n\n"
            f"All leads: https://ill.gtplkcbpl.com/admin\n")
        port = int(env('ILL_SMTP_PORT', '587'))
        with smtplib.SMTP(host, port, timeout=15) as s:
            if env('ILL_SMTP_STARTTLS', '1') == '1':
                s.starttls()
            if env('ILL_SMTP_USER'):
                s.login(env('ILL_SMTP_USER'), env('ILL_SMTP_PASSWORD', ''))
            s.send_message(msg)
    except Exception as e:  # never let mail problems lose a lead
        print('lead e-mail failed:', e, file=sys.stderr)


# ----------------------------------------------------------------------------------------------- reporting
def pct(a, b):
    return round(100.0 * a / b, 1) if b else 0.0


def summary(store, frm, to):
    t0, t1 = day_start(frm), day_start(to) + 86400
    S = store.q('SELECT * FROM sessions WHERE started >= ? AND started < ? AND bot = 0', (t0, t1))
    ev = defaultdict(lambda: defaultdict(int))      # sid -> type -> count
    lab = defaultdict(lambda: defaultdict(int))     # sid -> "type:label" -> count
    for r in store.q('''SELECT e.sid, e.type, e.label, COUNT(*) n FROM events e JOIN sessions s ON s.id = e.sid
                        WHERE s.started >= ? AND s.started < ? AND s.bot = 0 GROUP BY e.sid, e.type, e.label''', (t0, t1)):
        ev[r['sid']][r['type']] += r['n']
        lab[r['sid']][r['type'] + ':' + (r['label'] or '')] += r['n']
    L = store.q('SELECT * FROM leads WHERE ts >= ? AND ts < ? ORDER BY ts DESC', (t0, t1))
    lead_sids = defaultdict(int)
    for l in L:
        if l['status'] != 'spam':
            lead_sids[l['sid']] += 1
    real_leads = [l for l in L if l['status'] != 'spam']

    def flags(s):
        e = ev[s['id']]
        f = {
            'call': e.get('click_call', 0) > 0, 'copy': e.get('copy_phone', 0) > 0, 'wa': e.get('click_whatsapp', 0) > 0,
            'form': e.get('form_start', 0) > 0, 'lead': lead_sids.get(s['id'], 0) > 0,
        }
        f['interacted'] = any(e.get(t, 0) for t in INTERACTIVE) or f['lead']
        f['engaged'] = f['interacted'] or (s['engaged_ms'] or 0) >= ENGAGED_MS or (s['max_scroll'] or 0) >= 50
        f['contact'] = f['call'] or f['copy'] or f['wa'] or f['lead']
        return f

    F = {s['id']: flags(s) for s in S}
    n = len(S)

    def block(rows):
        k = len(rows)
        fl = [F[r['id']] for r in rows]
        eng = sum(1 for f in fl if f['engaged'])
        times = sorted((r['engaged_ms'] or 0) for r in rows)
        med = times[k // 2] if k else 0
        return {
            'sessions': k,
            'visitors': len({r['visitor'] for r in rows}),
            'bounce_rate': pct(k - eng, k),
            'median_time_s': round(med / 1000),
            'leads': sum(lead_sids.get(r['id'], 0) for r in rows),
            'calls': sum(1 for f in fl if f['call']),
            'copies': sum(1 for f in fl if f['copy']),
            'whatsapp': sum(1 for f in fl if f['wa']),
            'contact_rate': pct(sum(1 for f in fl if f['contact']), k),
        }

    totals = block(S)
    totals['returning'] = sum(1 for s in S if s['is_return'])
    totals['call_clicks'] = sum(ev[s['id']].get('click_call', 0) for s in S)
    totals['form_starts'] = sum(1 for s in S if F[s['id']]['form'])
    totals['form_abandons'] = sum(1 for s in S if F[s['id']]['form'] and not F[s['id']]['lead'])
    totals['form_abandon_rate'] = pct(totals['form_abandons'], totals['form_starts'])
    totals['leads'] = len(real_leads)  # include leads whose session started before the range

    funnel = [
        {'step': 'Visited', 'n': n},
        {'step': 'Engaged', 'n': sum(1 for f in F.values() if f['engaged'])},
        {'step': 'Started the form', 'n': totals['form_starts']},
        {'step': 'Submitted a lead', 'n': sum(1 for f in F.values() if f['lead'])},
    ]

    form = {
        'started': totals['form_starts'],
        'touched_pin': sum(1 for s in S if lab[s['id']].get('form_field:pin')),
        'touched_phone': sum(1 for s in S if lab[s['id']].get('form_field:phone')),
        'error_pin': sum(1 for s in S if lab[s['id']].get('form_error:pin')),
        'error_phone': sum(1 for s in S if lab[s['id']].get('form_error:phone')),
        'submitted': sum(1 for f in F.values() if f['lead'] and f['form']),
        'abandoned': totals['form_abandons'],
    }

    by = defaultdict(list)
    for s in S:
        by[source_of(s)].append(s)
    sources = sorted(({'source': k[0], 'medium': k[1], **block(v)} for k, v in by.items()), key=lambda r: -r['sessions'])
    camp = defaultdict(list)
    for s in S:
        if s['utm_campaign']:
            camp[(s['utm_campaign'], source_of(s)[0])].append(s)
    campaigns = sorted(({'campaign': k[0], 'source': k[1], **block(v)} for k, v in camp.items()), key=lambda r: -r['sessions'])
    dev = defaultdict(list)
    for s in S:
        dev[s['device'] or 'unknown'].append(s)
    devices = sorted(({'device': k, **block(v)} for k, v in dev.items()), key=lambda r: -r['sessions'])

    days = []
    d = t0
    while d < t1:
        days.append(ist_day(d))
        d += 86400
    daily = {k: {'date': k, 'sessions': 0, 'leads': 0, 'calls': 0, 'whatsapp': 0} for k in days}
    for s in S:
        k = ist_day(s['started'])
        if k in daily:
            daily[k]['sessions'] += 1
            daily[k]['calls'] += 1 if F[s['id']]['call'] else 0
            daily[k]['whatsapp'] += 1 if F[s['id']]['wa'] else 0
    for l in real_leads:
        k = ist_day(l['ts'])
        if k in daily:
            daily[k]['leads'] += 1

    hours = [{'hour': h, 'sessions': 0, 'contacts': 0} for h in range(24)]
    for s in S:
        h = int(time.gmtime(s['started'] + IST).tm_hour)
        hours[h]['sessions'] += 1
        hours[h]['contacts'] += 1 if F[s['id']]['contact'] else 0

    def label_counts(typ):
        c = defaultdict(int)
        for s in S:
            for k, v in lab[s['id']].items():
                if k.startswith(typ + ':'):
                    c[k.split(':', 1)[1] or 'other'] += 1  # sessions, not raw clicks
        return sorted(({'label': k, 'sessions': v} for k, v in c.items()), key=lambda r: -r['sessions'])

    sections = {r['label']: r['sessions'] for r in label_counts('section_view')}
    order = [('sectors', 'Sectors'), ('compare', 'Leased line vs broadband'), ('benefits', 'What you get'),
             ('how', 'Live in three moves'), ('why', 'Scale'), ('testimonials', 'Client stories'), ('cta', 'Final call to action')]
    reach = [{'id': i, 'label': t, 'sessions': sections.get(i, 0), 'pct': pct(sections.get(i, 0), n)} for i, t in order]

    leads_out = [{
        'id': l['id'], 'ts': l['ts'], 'phone': l['phone'], 'pin': l['pin'], 'status': l['status'], 'note': l['note'],
        'source': l['source'], 'medium': l['medium'], 'campaign': l['campaign'], 'device': l['device']} for l in L[:2000]]

    return {
        'range': {'from': frm, 'to': to}, 'generated': time.time(), 'totals': totals, 'funnel': funnel, 'form': form,
        'daily': [daily[k] for k in days], 'hours': hours, 'sources': sources, 'campaigns': campaigns, 'devices': devices,
        'call_placements': label_counts('click_call'), 'quote_placements': label_counts('click_quote'),
        'sectors': label_counts('sector_open'), 'reach': reach, 'leads': leads_out,
    }


# ----------------------------------------------------------------------------------------------- HTTP
LOGIN_HTML = '''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
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
<button type="submit">Sign in</button>__ERR__</form></body></html>'''


class App:
    def __init__(self):
        self.store = Store(env('ILL_DB', '/var/lib/ill-backend/ill.db'))
        pw_hash, secret = env('ILL_ADMIN_PASSWORD_HASH'), env('ILL_SECRET')
        if not pw_hash or not secret:
            sys.exit('ILL_ADMIN_PASSWORD_HASH and ILL_SECRET must be set (see ill-backend.env.example)')
        if len(secret) < 24:
            sys.exit('ILL_SECRET must be at least 24 characters')
        self.auth = Auth(secret, pw_hash)
        self.rl_events = RateLimit(240, 60)
        self.rl_leads = RateLimit(6, 600)
        self.admin_html = open(os.path.join(HERE, 'admin.html'), encoding='utf-8').read()
        self.retention = int(env('ILL_RETENTION_DAYS', '400'))
        self.last_prune = 0

    # ---- ingestion
    def ingest(self, ip, ua, data):
        sid, vid = clean(data.get('sid'), 40), clean(data.get('vid'), 40)
        if not SID_RE.match(sid) or not SID_RE.match(vid) or BOT_RE.search(ua or ''):
            return
        now = time.time()
        meta = data.get('meta') if isinstance(data.get('meta'), dict) else None
        exists = self.store.q('SELECT bot FROM sessions WHERE id = ?', (sid,))
        if exists and exists[0]['bot']:
            return
        if not exists:
            if not meta:  # events for a session we never saw start: ignore
                return
            device, browser, osn = parse_ua(ua)
            ref = clean(meta.get('ref'), 120).lower()
            if ref.endswith('gtplkcbpl.com') and ref.startswith('ill.'):
                ref = ''
            self.store.x('''INSERT OR IGNORE INTO sessions(id, visitor, is_return, started, last, ref_host, utm_source, utm_medium,
                            utm_campaign, utm_term, utm_content, click_id, device, browser, os, lang, screen)
                            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                         (sid, vid, 1 if meta.get('ret') else 0, now, now, ref,
                          clean(meta.get('us'), 80), clean(meta.get('um'), 80), clean(meta.get('uc'), 120),
                          clean(meta.get('ut'), 120), clean(meta.get('ux'), 120),
                          {'g': 'gclid', 'f': 'fbclid', 'm': 'msclkid'}.get(clean(meta.get('ck'), 2), ''),
                          device, browser, osn, clean(meta.get('lang'), 12), clean(meta.get('scr'), 12)))
        eng = data.get('eng') if isinstance(data.get('eng'), dict) else {}
        try:
            ms = max(0, min(int(eng.get('ms', 0)), 6 * 3600 * 1000))
            sc = max(0, min(int(eng.get('sc', 0)), 100))
        except (TypeError, ValueError):
            ms = sc = 0
        self.store.x('UPDATE sessions SET last = ?, engaged_ms = MAX(engaged_ms, ?), max_scroll = MAX(max_scroll, ?) WHERE id = ?',
                     (now, ms, sc, sid))
        rows = []
        for e in (data.get('ev') or [])[:60]:
            if not isinstance(e, dict):
                continue
            t = clean(e.get('t'), 20)
            if t in EVENT_TYPES:
                rows.append((sid, now, t, clean(e.get('l'), 40)))
        if rows:
            self.store.many('INSERT INTO events(sid, ts, type, label) VALUES(?,?,?,?)', rows)
        if now - self.last_prune > 86400:
            self.last_prune = now
            self.store.prune(self.retention)

    def mark_bot(self, sid):
        if SID_RE.match(sid or ''):
            self.store.x('UPDATE sessions SET bot = 1 WHERE id = ?', (sid,))
        return True, None

    def lead(self, ip, ua, data):
        sid = clean(data.get('sid'), 40)
        if clean(data.get('hp'), 200):  # honeypot field filled in: a bot. Pretend success, drop its visit from the stats.
            return self.mark_bot(sid)
        phone = re.sub(r'\D', '', clean(data.get('phone'), 20))[-10:]
        pin = clean(data.get('pin'), 10)
        if not PHONE_RE.match(phone) or not PIN_RE.match(pin):
            return False, 'invalid'
        try:
            if int(data.get('t', 0)) < 2500:  # submitted within 2.5 s of page load: a bot
                return self.mark_bot(sid)
        except (TypeError, ValueError):
            pass
        s = self.store.q('SELECT * FROM sessions WHERE id = ?', (sid,)) if SID_RE.match(sid) else []
        if s:
            src, med = source_of(s[0])
            camp, dev, ref = s[0]['utm_campaign'], s[0]['device'], s[0]['ref_host']
        else:
            src, med, camp, ref = '(unknown)', '(unknown)', '', ''
            dev = parse_ua(ua)[0]
        dup = self.store.q('SELECT id FROM leads WHERE phone = ? AND ts > ?', (phone, time.time() - 3600))
        if dup:  # same number again within the hour: keep one lead
            return True, None
        now = time.time()
        self.store.x('''INSERT INTO leads(ts, sid, phone, pin, source, medium, campaign, device, ref_host, updated)
                        VALUES(?,?,?,?,?,?,?,?,?,?)''', (now, sid, phone, pin, src, med, camp, dev, ref, now))
        threading.Thread(target=notify_lead, args=({'phone': phone, 'pin': pin, 'source': src, 'medium': med,
                                                     'campaign': camp, 'device': dev, 'ts': now},), daemon=True).start()
        return True, None

    def export_csv(self, frm, to):
        rows = self.store.q('SELECT * FROM leads WHERE ts >= ? AND ts < ? ORDER BY ts DESC', (day_start(frm), day_start(to) + 86400))
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(['Received (IST)', 'Mobile (+91)', 'PIN code', 'Status', 'Note', 'Source', 'Medium', 'Campaign', 'Device'])

        def cell(v):  # spreadsheet apps run = + - @ (or tab / CR) as a formula; notes and UTM tags come from outsiders
            v = '' if v is None else str(v)
            return "'" + v if v[:1] in ('=', '+', '-', '@', '\t', '\r') else v
        for r in rows:
            w.writerow([cell(v) for v in (time.strftime('%Y-%m-%d %H:%M', time.gmtime(r['ts'] + IST)), r['phone'], r['pin'],
                                          r['status'], r['note'], r['source'], r['medium'], r['campaign'], r['device'])])
        return '﻿' + buf.getvalue()


def make_handler(app):
    class H(BaseHTTPRequestHandler):
        server_version = 'ill-backend'
        sys_version = ''

        def log_message(self, fmt, *args):  # keep logs free of personal data
            if env('ILL_ACCESS_LOG') == '1':
                sys.stderr.write('%s %s\n' % (self.command, self.path.split('?')[0]))

        # -- utilities
        def ip(self):
            peer = self.client_address[0]
            fwd = self.headers.get('X-Forwarded-For', '')
            if peer in ('127.0.0.1', '::1') and fwd:
                return fwd.split(',')[-1].strip()
            return peer

        def https(self):
            return self.headers.get('X-Forwarded-Proto', '') == 'https'

        def body(self, limit=16 * 1024):
            n = int(self.headers.get('Content-Length') or 0)
            if n > limit:
                return None
            return self.rfile.read(n) if n else b''

        def send(self, code, data=b'', ctype='application/json', headers=None, admin=False):
            if isinstance(data, (dict, list)):
                data = json.dumps(data, separators=(',', ':')).encode()
            elif isinstance(data, str):
                data = data.encode()
            self.send_response(code)
            self.send_header('Content-Type', ctype + ('; charset=utf-8' if ctype.startswith(('text', 'application/json')) else ''))
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            if admin:
                self.send_header('X-Robots-Tag', 'noindex, nofollow')
                self.send_header('X-Frame-Options', 'DENY')
                self.send_header('Referrer-Policy', 'same-origin')  # 'no-referrer' makes browsers send Origin: null
                self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'")
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(data)

        def cookie(self):
            for part in (self.headers.get('Cookie') or '').split(';'):
                k, _, v = part.strip().partition('=')
                if k == 'ill_admin':
                    return v
            return ''

        def authed(self):
            return app.auth.valid(self.cookie())

        def same_origin(self):
            o = self.headers.get('Origin')
            if not o:
                return True
            if o == 'null':  # some same-site form posts; the browser's Sec-Fetch-Site then decides
                return self.headers.get('Sec-Fetch-Site') == 'same-origin'
            host = self.headers.get('X-Forwarded-Host') or self.headers.get('Host') or ''
            return urlparse(o).netloc == host

        def range_args(self, qs):
            today = ist_day(time.time())
            frm = (qs.get('from') or [today])[0]
            to = (qs.get('to') or [today])[0]
            try:
                day_start(frm), day_start(to)
            except ValueError:
                frm = to = today
            if frm > to:
                frm, to = to, frm
            return frm, to

        # -- routes
        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            u = urlparse(self.path)
            p, qs = u.path, parse_qs(u.query)
            if p == '/api/health':
                return self.send(200, {'ok': True})
            if p in ('/admin', '/admin/'):
                if not self.authed():
                    return self.send(200, LOGIN_HTML.replace('__ERR__', ''), 'text/html', admin=True)
                return self.send(200, app.admin_html, 'text/html', admin=True)
            if p.startswith('/admin/api/'):
                if not self.authed():
                    return self.send(401, {'error': 'signed out'}, admin=True)
                frm, to = self.range_args(qs)
                if p == '/admin/api/summary':
                    return self.send(200, summary(app.store, frm, to), admin=True)
                if p == '/admin/api/leads-export':
                    return self.send(200, app.export_csv(frm, to), 'text/csv', admin=True,
                                     headers={'Content-Disposition': f'attachment; filename="ill-leads-{frm}-to-{to}.csv"'})
            return self.send(404, {'error': 'not found'})

        def do_POST(self):
            p = urlparse(self.path).path
            ip, ua = self.ip(), self.headers.get('User-Agent', '')
            if p == '/api/e':
                raw = self.body(32 * 1024)
                if raw is not None and self.same_origin() and app.rl_events.allow(ip):
                    try:
                        app.ingest(ip, ua, json.loads(raw or b'{}'))
                    except (ValueError, sqlite3.Error) as e:
                        print('ingest error:', e, file=sys.stderr)
                return self.send(204)
            if p == '/api/lead':
                if not self.same_origin():
                    return self.send(403, {'ok': False})
                if not app.rl_leads.allow(ip):
                    return self.send(429, {'ok': False, 'error': 'too many'})
                raw = self.body()
                try:
                    ok, err = app.lead(ip, ua, json.loads(raw or b'{}'))
                except ValueError:
                    ok, err = False, 'invalid'
                return self.send(200 if ok else 400, {'ok': ok, 'error': err})
            if p in ('/admin/login', '/admin/logout') and not self.same_origin():
                return self.send(403, b'Forbidden', 'text/plain', admin=True)
            if p == '/admin/login':
                raw = self.body(4096) or b''
                pw = (parse_qs(raw.decode('utf-8', 'replace')).get('password') or [''])[0]
                if app.auth.attempt(ip, pw):
                    flags = 'HttpOnly; SameSite=Strict; Path=/admin; Max-Age=%d' % Auth.TTL + ('; Secure' if self.https() else '')
                    return self.send(303, b'', 'text/plain', headers={'Location': '/admin', 'Set-Cookie': 'ill_admin=' + app.auth.token() + '; ' + flags})
                msg = 'Too many attempts. Try again in 15 minutes.' if app.auth.locked(ip) else 'Wrong password.'
                return self.send(401, LOGIN_HTML.replace('__ERR__', '<p class="err" role="alert">' + msg + '</p>'), 'text/html', admin=True)
            if p == '/admin/logout':
                return self.send(303, b'', 'text/plain', headers={'Location': '/admin', 'Set-Cookie': 'ill_admin=; Path=/admin; Max-Age=0; HttpOnly; SameSite=Strict'})
            if p == '/admin/api/lead':
                if not self.authed():
                    return self.send(401, {'error': 'signed out'}, admin=True)
                if not self.same_origin() or self.headers.get('X-ILL-Admin') != '1':
                    return self.send(403, {'error': 'forbidden'}, admin=True)
                try:
                    data = json.loads(self.body() or b'{}')
                    lid = int(data.get('id'))
                except (ValueError, TypeError):
                    return self.send(400, {'error': 'bad request'}, admin=True)
                status, note = clean(data.get('status'), 12), clean(data.get('note'), 500)
                if status not in STATUSES:
                    return self.send(400, {'error': 'bad status'}, admin=True)
                app.store.x('UPDATE leads SET status = ?, note = ?, updated = ? WHERE id = ?', (status, note, time.time(), lid))
                return self.send(200, {'ok': True}, admin=True)
            return self.send(404, {'error': 'not found'})

    return H


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'serve'
    if cmd == 'hash-password':
        pw = getpass.getpass('New admin password: ')
        if len(pw) < 10:
            sys.exit('Use at least 10 characters.')
        if pw != getpass.getpass('Repeat it: '):
            sys.exit('Passwords did not match.')
        print('ILL_ADMIN_PASSWORD_HASH=' + hash_password(pw))
        return
    if cmd == 'secret':
        print('ILL_SECRET=' + secrets.token_urlsafe(48))
        return
    if cmd != 'serve':
        sys.exit(__doc__)
    app = App()
    host, port = env('ILL_HOST', '127.0.0.1'), int(env('ILL_PORT', '8787'))
    srv = ThreadingHTTPServer((host, port), make_handler(app))
    srv.daemon_threads = True
    print(f'ill-backend listening on {host}:{port}, database {app.store.path}', file=sys.stderr)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
