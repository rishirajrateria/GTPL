# GTPL KCBPL — Business Leased Line landing page

A single-page, self-contained landing page for GTPL KCBPL's Business Internet Leased Line:
white ground, frosted-glass panels, and the brand blue, red and yellow used as gradients.

## Files

- `index.html` — the whole page: markup, CSS and vanilla JavaScript in one file. No build step.

## Run it

Open `index.html` in a browser, or serve the folder with any static server:

```sh
npx serve .
```

## Page order

The page is built to be understood by scrolling straight down:

1. **Hero** — headline, four key figures, and the enquiry form, kept short so the client rail is visible without scrolling
2. **Client rail** — "1500+ companies run on our network" with a wordmark marquee
3. **Step one: why a leased line, not broadband** — three-column glass comparison
4. **Step two: what you get** — three proof panels (99.02% SLA gauge, symmetrical speed meters, packet-loss trace) above a single hairline grid holding the remaining twelve features
5. **Step three: live in three moves** — enquire, survey and quote, install
6. **Scale** — dark panel, eight figures in brand yellow
7. **Client stories** — three testimonials
8. **Call to action** and footer

Floating: WhatsApp button, desktop Enquire Now side tab, mobile sticky Call / Get a Quote bar.

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

- **Form backend**: the enquiry form is client-side only. Search for `TODO: wire form` in
  `index.html` and post the fields to your CRM or email endpoint.
- **Testimonials**: the three quotes are placeholders attributed to roles only. Replace them with
  real client quotes (see the `Placeholder testimonials` comment).
- **Client logos**: clients are shown as text wordmarks. Swap in real logo images if you have
  licence to use them.
- **Fonts**: Manrope loads from Google Fonts. Self-host it if the page must work without that request.
