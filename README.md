# GTPL KCBPL — Business Leased Line landing page

A single-page, self-contained landing page for GTPL KCBPL's Business Internet Leased Line offer,
redesigned with an Apple-style "liquid glass" treatment on the existing brand palette.

## Files

- `index.html` — the whole page: markup, CSS and vanilla JavaScript in one file. No build step.

## Run it

Open `index.html` in a browser, or serve the folder with any static server:

```sh
npx serve .
```

## What's inside

- Sticky glass nav, offer ticker, and a dark hero with an animated fibre-network canvas
- Glass enquiry form (Name, Email, Phone, Company, Industry, PIN, District) with client-side validation
- "Join 1500+ companies" wordmark marquee
- Benefits bento grid (15 benefits, 99.02% SLA gauge, symmetrical-speed meters)
- Leased Line vs Broadband glass comparison
- Why choose GTPL KCBPL — 8 tiles with count-up numbers
- Testimonials, final CTA band, footer, floating WhatsApp button, mobile sticky Call / Quote bar

## Brand tokens

Defined once at the top of the stylesheet in `index.html`:

| Token | Value | Use |
| --- | --- | --- |
| `--blue` | `#005aab` | GTPL blue, primary |
| `--red` | `#e12124` | KCBPL red, CTAs |
| `--yellow` | `#f8c102` | highlight words, stars, leased-line column |
| `--navy` | `#00183b` | dark sections |
| `--ice` | `#f3f9fe` | light sections |

## Before going live

- **Form backend**: the enquiry form is client-side only. Search for `TODO: wire form` in `index.html`
  and post the fields to your CRM or email endpoint.
- **Testimonials**: the three quotes are placeholders attributed to roles only. Replace them with real
  client quotes (see the `Placeholder testimonials` comment).
- **Client logos**: clients are shown as text wordmark chips. Swap in real logo images if you have
  licence to use them.
- **Fonts**: Outfit and Plus Jakarta Sans load from Google Fonts. Self-host them if you need the page
  to work without that request.
