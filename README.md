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

## Run it

Open `index.html` in a browser, or serve the folder with any static server:

```sh
npx serve .
```

## Page order

The page is built to be understood by scrolling straight down:

1. **Hero** — headline, four key figures, and a two-field availability check (PIN code and mobile), kept short so the client rail is visible without scrolling
2. **Client rail** — "1500+ companies run on our network" with a wordmark marquee
3. **Step one: why a leased line, not broadband** — two glass cards for the two real options, with
   the row labels as a plain right-aligned rail beside them rather than a third card
4. **Step two: what you get** — three proof panels (99.02% SLA gauge, symmetrical speed meters, packet-loss trace) above a single hairline grid holding the remaining twelve features
5. **Step three: live in three moves** — enquire, survey and quote, install
6. **Scale** — dark panel, eight figures in brand yellow
7. **Client stories** — three testimonials
8. **Call to action** and footer

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

- **Form backend**: the availability form is client-side only and collects PIN code and mobile
  number. Search for `TODO: wire form` in `index.html` and post the two fields to your CRM or
  email endpoint. Your team collects name, company and industry on the callback.
- **Testimonials**: the three quotes are placeholders attributed to roles only. Replace them with
  real client quotes (see the `Placeholder testimonials` comment).
- **Client logos**: each client sits behind a neutral placeholder mark (the `m-1` … `m-10` symbols
  in the sprite). These are abstract shapes, deliberately not imitations of anyone's real logo.
  Replace each `<use href="#m-n">` with the client's actual logo file once you have licence to use
  it.
- **Fonts**: Manrope loads from Google Fonts. Self-host it if the page must work without that request.
