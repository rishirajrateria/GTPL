# Free hosting on Cloudflare: ill.gtplkcbpl.com

The page, the enquiry form and the `/admin` dashboard run on Cloudflare's free plan: Cloudflare
Pages serves the page, Pages Functions handle the form and tracking, and a D1 database stores leads
and visits. Nothing to install and no server to look after. About 20 minutes, once.

What GTPL's DNS team adds is one **CNAME** record, not an IP address (step 6).

## 1. Create a free Cloudflare account

Sign up at https://dash.cloudflare.com/sign-up. No card is needed for the free plan.

## 2. Create the database

1. In the left menu: **Storage & databases → D1 SQL database → Create database**.
2. Name: `ill-db`. Location: leave automatic (or pick Asia-Pacific). **Create**.

The tables are created automatically the first time the site is used.

## 3. Create the Pages project from GitHub

1. Left menu: **Workers & Pages → Create application**, then the **Pages** tab
   (if the screen offers Workers first, look for "Pages" or "Looking to deploy Pages?")
   → **Import an existing Git repository**.
2. Connect GitHub and allow access to the repository `rishirajrateria/GTPL`. Select it, then **Begin setup**.
3. Fill in exactly:

   | Setting | Value |
   | --- | --- |
   | Project name | `gtpl-ill` (this becomes `gtpl-ill.pages.dev`) |
   | Production branch | `claude/ecstatic-mccarthy-sj43jp` |
   | Framework preset | None |
   | Build command | `node build.mjs` |
   | Build output directory | `public` |
   | Root directory (advanced) | `cloudflare` |

4. **Save and Deploy**. The first build takes about a minute.

Only the page files are published (`index.html`, `favicon.svg`, `og-image.jpg`, `robots.txt`,
`sitemap.xml`, a 404 page). The customer spreadsheet in `data/` and all source code stay private.
Once this works you can make the GitHub repository private; Cloudflare keeps its access.

## 4. Connect the database and set the admin password

In the Pages project (`gtpl-ill`) → **Settings**:

1. **Bindings → Add → D1 database**. Variable name: `DB`. Database: `ill-db`. **Save**.
2. **Variables and Secrets → Add**. Type: **Secret**. Name: `ADMIN_PASSWORD`. Value: a password of
   at least 10 characters that you keep. **Save**.
3. Go to **Deployments**, open the latest deployment's **⋯** menu → **Retry deployment**.
   (Bindings and secrets only apply to new deployments.)

Do both for **Production**. If the dashboard asks, Preview can stay empty.

## 5. Check it on the test address

1. Open `https://gtpl-ill.pages.dev` — the page loads.
2. Submit the form once with a real mobile number — it should say "Thanks".
3. Open `https://gtpl-ill.pages.dev/admin`, sign in with the password — the lead is listed.
   Set its status to **spam** so the test does not count.

If `/admin` says the password is not set up, or the form says "That didn't go through", step 4 is
missing or the deployment was not retried.

## 6. Connect ill.gtplkcbpl.com

1. Pages project → **Custom domains → Set up a custom domain** → `ill.gtplkcbpl.com` → **Continue**.
2. Cloudflare shows a CNAME record because the domain's DNS is elsewhere. Send it to GTPL's DNS team:

   > Please add a DNS record for ill.gtplkcbpl.com:
   > Type **CNAME**, Name **ill**, Target **gtpl-ill.pages.dev**, TTL 300.

3. Once they add it, the domain turns **Active** within minutes to a few hours and HTTPS is set up
   automatically. Then use `https://ill.gtplkcbpl.com/admin`.

## Updating the site

Any change pushed to the branch above is published automatically in about a minute.

## Limits of the free plan

| | Free allowance | This site |
| --- | --- | --- |
| Page views | Unlimited | — |
| Form + tracking requests | 100,000 a day | a visit makes ~3–10 |
| Database writes | 100,000 rows a day | a visit makes ~2–5 |
| Database storage | 5 GB | years of visits |

If a daily allowance were ever used up, tracking would pause until 05:30 IST and the form would show
its "please call +91 6293760118" message. At that point the $5/month Workers Paid plan removes the
limits.

## Differences from the self-hosted version (`server/`)

- No e-mail alert per lead (Cloudflare's free plan has no outgoing mail). Check `/admin` or export to Excel.
- Changing `ADMIN_PASSWORD` signs everyone out of `/admin`.
- Visits older than 400 days are deleted automatically; leads are kept.
