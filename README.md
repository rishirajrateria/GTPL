# GTPL KCBPL — Business Leased Line landing page

A single-page, self-contained landing page for GTPL KCBPL's Business Internet Leased Line:
white ground, frosted-glass panels, and the brand blue, red and yellow used as gradients.

## Files

- `index.html` — the whole page: markup, CSS, vanilla JavaScript and the logo in one file. No build step.

- `logo.svg` — the brand logo as a standalone vector, for reuse elsewhere.

The logo is a vector: the supplied PNG was traced into three flat colour layers (blue, red and the
globe's yellow) and lives as an SVG `<symbol id="logo">` in the sprite at the top of the body. The
header and footer both reference it with `<use href="#logo">`, so it is stored once, stays sharp at
any size and on any display, and the page still makes no image requests.

## Launch

The site goes live at **https://ill.gtplkcbpl.com**, in one of two ways:

- **Cloudflare (free, recommended):** `cloudflare/` holds a Cloudflare Pages version — the page,
  the form, tracking and `/admin` on Pages Functions with a D1 database. Setup is click-by-click in
  `cloudflare/CLOUDFLARE.md`; GTPL's DNS team only adds a CNAME record.
- **Your own server:** `deploy/` holds a one-command installer (`deploy/install.sh`), tested nginx
  and Apache configs and `deploy/DEPLOY.md`; GTPL's DNS team adds an A record with the server's IP.

Either way only five files are public: `index.html`, `favicon.svg`, `og-image.jpg`, `robots.txt`
and `sitemap.xml`. Never publish `data/`, which holds the customer spreadsheet.

## Leads and the /admin dashboard

The same features exist twice: `cloudflare/` (Pages Functions + D1, JavaScript) and `server/`
(a small Python service, standard library only, one SQLite file, behind nginx or Apache). Both
serve the same dashboard, `server/admin.html`:

- `POST /api/lead` receives the availability form (PIN code + mobile), with a honeypot, a
  too-fast-to-be-human check, per-IP rate limits and same-number de-duplication. The self-hosted
  version can also e-mail each lead.
- `POST /api/e` receives cookie-free, first-party activity from the page: visits, call taps (and
  which button), WhatsApp opens, number copies, form starts, field errors, sector opens, section
  reach and scroll depth, plus UTM tags and ad click IDs.
- `/admin` is a password-protected dashboard: visitors, bounce rate, contact rate, the
  visit → engaged → form → lead funnel, form drop-off by field, sources and campaigns with their
  contact rates, devices, hour of day, and a lead list with status, notes and CSV export.

The page only reports activity when served from `gtplkcbpl.com`, a `*.pages.dev` test address or
`localhost`, so previews elsewhere send nothing. Open `server/admin.html` directly in a browser to
see the dashboard with sample data.

## Run it

Open `index.html` in a browser, or serve the folder with any static server:

```sh
npx serve .
```

## Page order

The page is built to be understood by scrolling straight down:

1. **Hero** — headline, four key figures, and a two-field availability check (PIN code and mobile), kept short so the client rail is visible without scrolling
2. **Client rail** — "1500+ companies run on our network" with a wordmark marquee
3. **Sectors** — 17 industry chips (no client counts shown), generated from
   `data/Company_details_sector_wise.xlsx`. Tapping one opens a panel listing every client in that
   sector with its locations; long location lists collapse to three with a "+N more" toggle. The
   names are static HTML, so search engines and AI crawlers can read them
4. **Step one: why a leased line, not broadband** — two glass cards for the two real options, with
   the row labels as a plain right-aligned rail beside them rather than a third card
5. **Step two: what you get** — three proof panels (99.02% SLA gauge, symmetrical speed meters, packet-loss trace) above a single hairline grid holding the remaining twelve features
6. **Step three: live in three moves** — enquire, survey and quote, install
7. **Scale** — dark panel, eight figures in brand yellow
8. **Client stories** — three testimonials
9. **Call to action** and footer

Floating: WhatsApp button, desktop Enquire Now side tab, mobile sticky Call / Get a Quote bar.

## The fibre motif

One idea runs through the page: light travelling down a fibre line.

- **Hero strands** — a canvas of fibre strands carrying light pulses, blue with occasional gold.
  They lean toward the cursor. Held well back with a low opacity and a gradient mask that clears
  the area behind the copy entirely, so nothing competes with the text. Paused when off-screen or
  the tab is hidden.
- **Headline sweep** — a specular band crossing "Leased Line", kept inside blue.
- **Self-healing ring** — the uptime gauge doubles as a protected ring. A packet circles it; every
  few seconds a span cuts, the packet turns red and reverses, "REROUTING" appears, then it heals.
  This is what the 99.02% figure actually rests on.
- **Live status** — a pulsing "All rings operational" chip beside the hero eyebrow.
- **Grid spotlight** — the feature grid lights up as one surface under the cursor.
- **Panel scan** — a slow gold sweep across the dark scale panel.

Every one of these is disabled under `prefers-reduced-motion`.

## Brand tokens

Defined once at the top of the stylesheet in `index.html`. These are the exact shades supplied
by the client; the neutrals are tuned toward blue rather than pure grey.

| Token | Value | Use |
| --- | --- | --- |
| `--blue` | `#2458a4` | GTPL blue, primary |
| `--red` | `#d93832` | KCBPL red |
| `--yellow` | `#f2cb4d` | gradient tails, figures on the dark panel, stars |
| `--navy` | `#0d1f3c` | the one dark panel (neutral, not a brand shade) |

Each colour has one job, so the three never blur into each other:

- **Blue** is the product — headline emphasis, every icon, the leased-line column, the uptime
  gauge, the download meter, the packet-loss trace.
- **Red** is action and negation — every call-to-action button, the Recommended ribbon, the step
  numbers, the crosses against broadband, required-field markers, the upload meter.
- **Yellow** is the highlight — figures on the dark panel, stars, comparison pills, the endpoint
  of the trace.

Gradients stay inside one hue (`--g-blue`, `--g-red`). Blue is never blended into red: their
midpoint is a muddy purple that reads as neither brand colour. Where all three must appear
together, `--g-tri` sets them as hard-stopped segments rather than a blend. Yellow is never text
on white: at 1.8:1 it fails the contrast bar, so it carries shapes, edges and the dark panel.

## Before going live

- **Testimonials**: the three quotes are placeholders attributed to roles only. Replace them with
  real client quotes (see the `Placeholder testimonials` comment).
- **Clients by sector**: edit `data/Company_details_sector_wise.xlsx`, then rebuild the band:

  ```sh
  python3 data/build_sectors.py data/Company_details_sector_wise.xlsx index.html data/sector-report.json
  ```

  The script replaces the sectors section, its styles and its script in place. Read
  `data/REVIEW.md` first: 53 businesses have no sector and are not shown, and a few entries look
  like typos or notes rather than client names.
- **Client logos**: the rail shows the five supplied logos (Wipro, Kolkata Airport, Globe TV, NDIA,
  Vibtree), each embedded once as a `.marquee .lg-*` background and also saved under `logos/`.
  They sit greyscale at rest and go full colour on hover. To add a client, key out its background,
  add a `.marquee .lg-name` rule and a `<li>` in each of the six repeats of the marquee list.
- **Fonts**: Manrope loads from Google Fonts. Self-host it if the page must work without that request.
