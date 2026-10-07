import sys, re, json, html, collections, openpyxl
XL, PAGE = sys.argv[1], sys.argv[2]
ws = openpyxl.load_workbook(XL, data_only=True).worksheets[0]

# ---- chips: sheet segments, with the three tiny ones folded into a neighbour ----
GROUPS = [  # key, chip label, panel title, icon, sheet segments
 ('it','IT & Technology','IT & Technology','i-chip',['IT & Technology']),
 ('telecom','Telecom','Telecom & Networking','i-tower',['Telecom & Networking']),
 ('health','Healthcare','Healthcare & Pharma','i-health',['Healthcare & Pharma','Education & Healthcare']),
 ('edu','Education','Education','i-cap',['Education','Education & Healthcare']),
 ('retail','Retail','Retail','i-bag',['Retail']),
 ('mfg','Manufacturing','Manufacturing & Industrial','i-factory',['Manufacturing & Industrial']),
 ('auto','Automobile','Automobile','i-car',['Automobile']),
 ('gov','Government','Government & Public Sector','i-corp',['Government & Public Sector']),
 ('media','Media','Media & Entertainment','i-media',['Media & Entertainment']),
 ('logi','Logistics','Logistics & Transport','i-truck',['Logistics & Transport']),
 ('trade','Trading','Trading & Distribution','i-box',['Trading & Distribution']),
 ('food','Food & FMCG','Food, FMCG & Agriculture','i-food',['Food & Beverage','FMCG & Consumer Goods','Agriculture & Plantation']),
 ('bfsi','BFSI','Banking & Financial Services','i-bank',['Banking & Financial Services']),
 ('realty','Real Estate','Real Estate & Infrastructure','i-city',['Real Estate & Infrastructure']),
 ('hosp','Hospitality','Hospitality & Travel','i-bed',['Hospitality','Travel & Tourism']),
 ('pro','Professional Services','Business & Professional Services','i-brief',['Business & Professional Services']),
 ('energy','Energy','Energy & Power','i-bolt',['Energy & Power']),
]
SUFFIX = re.compile(r'[\s,.]*(\(\s*P\s*\)\s*)?(PVT\.?\s*LTD\.?|PRIVATE\s+LIMITED|PVT\.?\s*LIMITED|LIMITED|LTD\.?|LLP|PVT\.?)[\s.]*$', re.I)
def display_name(raw):
    n = ' '.join(str(raw).split())
    n = re.sub(r'^M/S\.?\s+', '', n, flags=re.I)
    n = re.sub(r'\s+\d+$', '', n)  # stray row counters, e.g. 'PVT LTD 1'
    prev = None
    while prev != n:
        prev = n; n = SUFFIX.sub('', n).strip(' ,.')
    return n or ' '.join(str(raw).split())
def key(n): return re.sub(r'[^A-Z0-9&]+', ' ', n.upper()).strip()
def place(s):
    s = ' '.join(str(s or '').split())
    if not s or s.upper() == 'NA': return ''
    return s.title() if s.isupper() else s

seg_rows = collections.defaultdict(list)
for _, cust, loc, dist, seg in ws.iter_rows(min_row=2, values_only=True):
    if cust: seg_rows[(seg or 'NA').strip()].append((cust, place(loc), place(dist)))

used = set(s for g in GROUPS for s in g[4])
unused = [s for s in seg_rows if s not in used]
panels = []
for gk, label, title, icon, segs in GROUPS:
    brands = collections.OrderedDict()
    for s in segs:
        for cust, loc, dist in seg_rows.get(s, []):
            nm = display_name(cust); k = key(nm)
            b = brands.setdefault(k, {'name': nm, 'sites': [], 'districts': set()})
            if loc and dist and loc.lower() != dist.lower(): site = f'{loc}, {dist}'
            else: site = loc or dist
            if site and site not in b['sites']: b['sites'].append(site)
            if dist: b['districts'].add(dist)
    items = sorted(brands.values(), key=lambda b: b['name'].upper())
    districts = set().union(*[b['districts'] for b in items]) if items else set()
    panels.append(dict(k=gk, label=label, title=title, icon=icon, items=items, districts=len(districts)))

panels.sort(key=lambda p: -len(p['items']))
total = len({key(b['name']) for p in panels for b in p['items']})

E = lambda t: html.escape(t, quote=True)
chips = '\n      '.join(
  f'<li><button class="sct" type="button" aria-expanded="false" aria-controls="sp-{p["k"]}" data-k="{p["k"]}">'
  f'<span class="ic"><svg class="i" aria-hidden="true" focusable="false"><use href="#{p["icon"]}"/></svg></span><span class="lbl">{E(p["label"])}</span>'
  f'<span class="n">{len(p["items"])}</span>'
  f'<svg class="cv" aria-hidden="true" focusable="false"><use href="#i-chev"/></svg></button></li>' for p in panels)

def panel_html(p):
    cards = []
    for i, b in enumerate(p['items']):
        site = ''
        if b['sites']:
            head, rest = b['sites'][:3], b['sites'][3:]
            body = E(' · '.join(head))
            if rest:
                body += ('<span class="rest" hidden> · ' + E(' · '.join(rest)) + '</span>'
                         f' <button class="more" type="button" aria-expanded="false">+{len(rest)} more</button>')
            site = ('<span class="loc"><svg class="i" aria-hidden="true" focusable="false"><use href="#i-pin"/></svg><span>'
                    + body + '</span></span>')
        cards.append(f'<li class="sp-item" style="--d:{min(i,14)*28}ms"><b>{E(b["name"])}</b>{site}</li>')
    meta = f'<b>{len(p["items"])}</b> {"client" if len(p["items"])==1 else "clients"} in {E(p["title"])}'
    if p['districts']: meta += f' <i>·</i> {p["districts"]} {"district" if p["districts"]==1 else "districts"}'
    return (f'<div class="sp" id="sp-{p["k"]}" role="region" aria-label="{E(p["title"])} clients" hidden>'
            f'<p class="sp-h">{meta}</p><ul class="sp-grid">{"".join(cards)}</ul></div>')

panels_html = '\n          '.join(panel_html(p) for p in panels)

section = f'''<section class="sec slim sectors" id="sectors" aria-labelledby="sc-h">
  <div class="wrap">
    <div class="head rv">
      <span class="eyebrow">Sectors</span>
      <h2 id="sc-h">Serving businesses across <span class="grad">every industry</span></h2>
      <p class="sub"><b>{total}</b> businesses across {len(panels)} sectors. Pick one to see who we connect, and where.</p>
    </div>
    <!-- Generated from Company_details_sector_wise.xlsx. Chips sorted by number of clients. -->
    <ul class="row rv d1">
      {chips}
    </ul>
    <div class="sct-wrap" id="sector-wrap">
      <div class="sct-inner">
        <div class="sct-panel glass" id="sector-panel" aria-live="polite">
          {panels_html}
        </div>
      </div>
    </div>
  </div>
</section>

'''
s = open(PAGE).read()
a = s.index('<section class="sec slim sectors" id="sectors"'); b = s.index('<!-- =============== 1. WHY A LEASED LINE')
s = s[:a] + section + s[b:]

# ---- styles ----
a = s.index('.sct-wrap{display:grid;grid-template-rows:0fr;'); b = s.index('@keyframes pop{to{opacity:1;transform:none}}') + len('@keyframes pop{to{opacity:1;transform:none}}')
s = s[:a] + '''.sectors .sub{font-size:14px;color:var(--ink-3)}
.sectors .sub b{color:var(--blue)}
.sectors .row{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;max-width:1100px}
.sectors .row li{display:flex;min-width:0;flex:0 0 auto}
.sectors .row .sct{width:100%;min-width:0}
.sct .lbl{min-width:0}
.sct .n{margin-left:auto}
@media (max-width:640px){
  .sectors .row{gap:8px}
  .sectors .row li{flex:0 0 calc(50% - 4px)}
  .sectors .row .sct{padding:7px 9px 7px 7px;gap:8px;font-size:12.5px;white-space:normal;line-height:1.2;text-align:left}
  .sectors .row .sct .cv{display:none}
}
.sct .n{min-width:22px;padding:1px 7px;border-radius:99px;font-size:11px;font-weight:800;line-height:18px;text-align:center;
  color:var(--blue);background:rgba(36,88,164,.09);font-variant-numeric:tabular-nums}
.sct[aria-expanded="true"] .n{color:var(--blue);background:#fff}
.sct-wrap{display:grid;grid-template-rows:0fr;margin-top:0;
  transition:grid-template-rows .45s var(--ease),margin-top .45s var(--ease)}
.sct-wrap.open{grid-template-rows:1fr;margin-top:18px}
.sct-wrap{scroll-margin-top:96px}
.sct-inner{overflow:hidden;min-height:0}
.sct-panel{max-width:1080px;margin-inline:auto;padding:20px 20px 16px}
.sp-h{font-size:11.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-4);margin-bottom:14px;text-align:center}
.sp-h b{color:var(--blue);letter-spacing:.04em}
.sp-h i{font-style:normal;margin:0 4px;color:var(--ink-4)}
.sp-grid{display:block;columns:3 240px;column-gap:8px;max-height:min(440px,62vh);overflow:auto;
  padding:2px 4px 6px;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:rgba(36,88,164,.3) transparent}
.sp-grid.more{-webkit-mask-image:linear-gradient(180deg,#000 calc(100% - 34px),transparent);mask-image:linear-gradient(180deg,#000 calc(100% - 34px),transparent)}
.sp-item{display:block;break-inside:avoid;margin-bottom:8px;padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.62);
  box-shadow:inset 0 0 0 1px rgba(36,88,164,.1);opacity:0;transform:translateY(6px);animation:pop .32s var(--ease) var(--d,0ms) forwards}
.sp-item b{display:block;font-size:12px;font-weight:800;letter-spacing:.035em;text-transform:uppercase;color:var(--ink);line-height:1.3}
.sp-item .loc{display:flex;align-items:flex-start;gap:5px;margin-top:5px;font-size:12px;font-weight:500;line-height:1.45;color:var(--ink-3)}
.sp-item .more{border:0;padding:0;background:none;font:inherit;font-weight:700;color:var(--blue);cursor:pointer;white-space:nowrap}
.sp-item .more:hover{text-decoration:underline}
.sp-item .loc .i{width:12px;height:12px;flex:none;margin-top:2px;color:var(--blue)}
@keyframes pop{to{opacity:1;transform:none}}
''' + s[b:]
s = s.replace('''  .sct-panel{padding:16px 14px}
  .sp-list li{font-size:12.5px;padding:7px 12px}''', '''  .sct-panel{padding:14px 10px 10px}
  .sp-grid{columns:1;max-height:60vh}''', 1)
s = s.replace(',.sct-wrap,.sp-list li,.sct .cv{animation:none!important;transition:none!important}\n  .sp-list li{opacity:1;transform:none}',
              ',.sct-wrap,.sp-item,.sct .cv{animation:none!important;transition:none!important}\n  .sp-item{opacity:1;transform:none}', 1)

# ---- icons ----
s = s.replace('    <symbol id="i-truck"', '''    <symbol id="i-tower" viewBox="0 0 24 24"><path d="M12 10v11M8.5 21h7M9.5 14l2.5-4 2.5 4"/><path d="M7.8 6.8a6 6 0 0 0 0 6.4M16.2 6.8a6 6 0 0 1 0 6.4M5 4a10 10 0 0 0 0 12M19 4a10 10 0 0 1 0 12"/><circle cx="12" cy="10" r="1.3"/></symbol>
    <symbol id="i-car" viewBox="0 0 24 24"><path d="M4 16v-4l2-5h12l2 5v4zM4 16v2.5M20 16v2.5M4 12h16"/><circle cx="8" cy="14.2" r="1"/><circle cx="16" cy="14.2" r="1"/></symbol>
    <symbol id="i-box" viewBox="0 0 24 24"><path d="M3.5 7.5L12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5L12 12l8.5-4.5M12 12v9M7.8 5.3l8.5 4.5"/></symbol>
    <symbol id="i-food" viewBox="0 0 24 24"><path d="M5 10h12v3a6 6 0 0 1-12 0z"/><path d="M17 11h1.5a2 2 0 0 1 0 4H17M8 3c0 1.5 1 1.5 1 3M12 3c0 1.5 1 1.5 1 3M4 21h14"/></symbol>
    <symbol id="i-city" viewBox="0 0 24 24"><path d="M3 21h18M5 21V9l5-3v15M10 21V4l6 3v14M16 21V11l4 2v8"/><path d="M7 12h1M7 15h1M12.5 9h1M12.5 12h1M12.5 15h1"/></symbol>
    <symbol id="i-truck"''', 1)

# ---- behaviour ----
a = s.index('  /* ---------- sectors: tap an industry to see who we serve there ---------- */')
b = s.index('  /* ---------- ring protection: a link cuts, traffic routes the other way ---------- */')
s = s[:a] + '''  /* ---------- sectors: tap an industry to see who we serve there ---------- */
  (function(){
    var wrap=d.getElementById('sector-wrap'); if(!wrap) return;
    var btns=[].slice.call(d.querySelectorAll('.sct')), open=null;
    function markScroll(p){ var g=p&&p.querySelector('.sp-grid'); if(!g) return;
      function upd(){ g.classList.toggle('more', g.scrollHeight-g.scrollTop-g.clientHeight>4); }
      upd(); if(!g.dataset.w){ g.dataset.w='1'; g.addEventListener('scroll',upd,{passive:true}); w.addEventListener('resize',upd,{passive:true}); } }
    function setOpen(btn){
      btns.forEach(function(b){
        var on=b===btn, p=d.getElementById(b.getAttribute('aria-controls'));
        b.setAttribute('aria-expanded',String(on)); if(p) p.hidden=!on;
        if(on&&p){ var g=p.querySelector('.sp-grid'); if(g) g.scrollTop=0; markScroll(p); }
      });
      wrap.classList.toggle('open',!!btn); open=btn||null;
      if(btn){                       /* bring the list into view if it opened off-screen */
        var RMq=w.matchMedia&&w.matchMedia('(prefers-reduced-motion: reduce)').matches;
        setTimeout(function(){ var r=wrap.getBoundingClientRect();
          if(r.top>w.innerHeight-140||r.top<70) wrap.scrollIntoView({behavior:RMq?'auto':'smooth',block:'start'}); }, RMq?0:260);
      }
    }
    btns.forEach(function(b){ b.addEventListener('click',function(){ setOpen(open===b?null:b); }); });
    wrap.addEventListener('click',function(e){
      var m=e.target.closest&&e.target.closest('.more'); if(!m) return;
      var r=m.parentNode.querySelector('.rest'), on=m.getAttribute('aria-expanded')!=='true';
      if(r) r.hidden=!on; m.setAttribute('aria-expanded',String(on));
      m.textContent=on?'Show less':'+'+(r?r.textContent.split(' · ').length-1:0)+' more';
      markScroll(m.closest('.sp'));
    });
    d.addEventListener('keydown',function(e){ if(e.key==='Escape'&&open){ var t=open; setOpen(null); t.focus(); } });
  })();

''' + s[b:]
open(PAGE, 'w').write(s)

report = {'total_brands': total, 'chips': [(p['label'], len(p['items']), p['districts']) for p in panels],
          'unused_segments': {u: len(seg_rows[u]) for u in unused},
          'na_brands': sorted({display_name(c) for c,_,_ in seg_rows.get('NA', [])})}
json.dump(report, open(sys.argv[3], 'w'), indent=1)
print(json.dumps({k: report[k] for k in ('total_brands','chips','unused_segments')}, indent=1))
