# Launching ill.gtplkcbpl.com

The GTPL KCBPL Business Leased Line page is a **single static page** plus one **small Python
service** that receives the enquiry form, counts visitor activity and serves the `/admin` dashboard.
Going live is DNS, five files, the service, one virtual host and HTTPS.

The service (`server/ill_backend.py`) uses only Python 3.8+'s standard library: nothing to `pip
install`, no separate database server. Everything is kept in one SQLite file on this machine.

| | |
| --- | --- |
| Address | `https://ill.gtplkcbpl.com` |
| Web root | `/var/www/ill.gtplkcbpl.com` (any folder works; update the config to match) |
| Server | `103.211.23.150` is what `gtplkcbpl.com` resolves to today. Use it if this site goes on the same machine, otherwise use the IP of the server you choose. |
| Source | https://github.com/rishirajrateria/GTPL (branch `claude/ecstatic-mccarthy-sj43jp`) |

## 1. DNS

Add one record in the `gtplkcbpl.com` zone:

| Type | Name | Value | TTL |
| --- | --- | --- | --- |
| A | `ill` | `103.211.23.150` | 300 |

In a BIND zone file that line is:

```
ill    300    IN    A    103.211.23.150
```

Remember to bump the zone serial. Raise the TTL to 3600 once everything works. Check it with:

```sh
dig +short ill.gtplkcbpl.com        # expect 103.211.23.150
```

## 2. Upload the site

Copy these **five files**, and only these, into the web root:

```
index.html     the whole page (styles, scripts, logos and client data are inside it)
favicon.svg    browser tab icon
og-image.jpg   preview image for WhatsApp, LinkedIn, Google
robots.txt     tells search engines they may index the page
sitemap.xml    page address for search engines
```

They are in the `site/` folder of this package, or in the root of the GitHub repo.

```sh
sudo mkdir -p /var/www/ill.gtplkcbpl.com
sudo cp site/* /var/www/ill.gtplkcbpl.com/
sudo chown -R www-data:www-data /var/www/ill.gtplkcbpl.com
```

**Do not upload the rest of the repository.** `data/` holds the customer spreadsheet. Both configs
below block `data/`, `deploy/`, `logos/`, dot-files and `.xlsx/.py/.md/.json` files as a safety
net, but they should simply not be on the server.

## 3. Leads and analytics service

Needs Python 3.8 or newer (`python3 --version`) and systemd.

```sh
sudo mkdir -p /opt/ill-backend
sudo cp server/ill_backend.py server/admin.html /opt/ill-backend/
sudo chmod 644 /opt/ill-backend/*

# Create the admin password and the cookie-signing secret. Each command prints one line.
python3 /opt/ill-backend/ill_backend.py hash-password     # asks for the password twice
python3 /opt/ill-backend/ill_backend.py secret

sudo cp server/ill-backend.env.example /etc/ill-backend.env
sudo nano /etc/ill-backend.env          # paste the two printed lines into it
sudo chmod 600 /etc/ill-backend.env

sudo cp server/ill-backend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ill-backend
curl -s http://127.0.0.1:8787/api/health     # {"ok":true}
```

It listens only on `127.0.0.1:8787`; the web server below forwards `/api/` and `/admin` to it.
The database is created at `/var/lib/ill-backend/ill.db`. Back that one file up.

Send the admin password to the marketing owner separately (not in the same message as this guide).
To change it later, run `hash-password` again, replace the line in `/etc/ill-backend.env`, and
`sudo systemctl restart ill-backend`. Changing `ILL_SECRET` signs everyone out.

**E-mail alert for each lead (optional).** Fill in the `ILL_SMTP_*` and `ILL_NOTIFY_TO` lines in
`/etc/ill-backend.env` with any mailbox that allows SMTP sending, then restart the service. If mail
fails, the lead is still saved and visible in `/admin`.

## 4. Web server

Use whichever the server already runs. Both configs were tested on nginx 1.24 and Apache 2.4.

### nginx

```sh
sudo cp nginx/ill.gtplkcbpl.com.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/ill.gtplkcbpl.com.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

If the server has no IPv6, delete the `listen [::]:80;` line.

If you add your own `listen 443 ssl` block instead of using certbot, copy the two
`location ^~ /api/` and `location ^~ /admin` blocks into it too, or the form and dashboard stop working
over HTTPS. (certbot copies them for you.)

### Apache

```sh
sudo a2enmod headers deflate expires proxy proxy_http
sudo cp apache/ill.gtplkcbpl.com.conf /etc/apache2/sites-available/
sudo a2ensite ill.gtplkcbpl.com
sudo apachectl configtest && sudo systemctl reload apache2
```

## 5. HTTPS

Once DNS resolves to the server, issue a free certificate. This also adds the http→https redirect:

```sh
sudo certbot --nginx  -d ill.gtplkcbpl.com --redirect    # nginx
sudo certbot --apache -d ill.gtplkcbpl.com --redirect    # Apache
```

If you already hold a wildcard certificate for `*.gtplkcbpl.com`, add a 443 block using it
instead. Once HTTPS works, uncomment the `Strict-Transport-Security` line in the config and reload.

## 6. Check it

```sh
curl -sI https://ill.gtplkcbpl.com/ | head -1                       # HTTP/2 200 (or HTTP/1.1 200)
curl -sI http://ill.gtplkcbpl.com/  | grep -i location               # redirects to https
curl -s -o /dev/null -w '%{http_code}\n' https://ill.gtplkcbpl.com/data/   # 404 or 403, never 200
curl -s https://ill.gtplkcbpl.com/api/health                          # {"ok":true}
```

Then in a browser: the page loads with the logo, the tab shows the globe icon, and tapping a sector
lists its clients. Paste the link into WhatsApp to confirm the preview image appears.

Finally, submit the form once with a real mobile number, open `https://ill.gtplkcbpl.com/admin`,
sign in, and check the lead is listed. Mark it `spam` afterwards so it does not count.

## Updating later

Replace `index.html` (and any changed file) in the web root. No restart is needed; the page is
served with `no-cache`, so visitors get the new version on their next load.

To update the service, copy the new `ill_backend.py` / `admin.html` into `/opt/ill-backend/` and run
`sudo systemctl restart ill-backend`. The database is kept.

## What /admin tracks, and what it does not

- **Leads**: every PIN code and phone number submitted, with the ad or site that brought the visitor.
  Mark each one contacted / qualified / won / lost / spam, add a note, and export to Excel (CSV).
- **Calls, WhatsApp, number copied**: visits that tapped a call button (and which one), opened
  WhatsApp, or copied the number from the page. On phones, long-pressing a number and choosing
  "Copy" happens outside the page and cannot be seen by any website.
- **Form started but abandoned**, and which field people stopped at or got an error on.
- **Bounce rate**: visits that left within 10 seconds without scrolling halfway, tapping or typing.
- **Traffic sources and campaigns**: Google Ads, Meta, LinkedIn, Google search, ChatGPT and other AI
  assistants, direct, other websites. For each ad to show up by name, end every ad's link with UTM
  tags, for example
  `https://ill.gtplkcbpl.com/?utm_source=google&utm_medium=cpc&utm_campaign=ill-kolkata-search`.
  Google Ads auto-tagging (`gclid`) and Meta's `fbclid` are recognised even without them.
- **Devices, hour of day, how far people scroll, which sectors they open.**

**Privacy.** Tracking is first-party and cookie-free: no Google Analytics, no third-party scripts,
no IP addresses stored, nothing shared outside this server. A random ID in the visitor's browser
storage tells new and returning visitors apart. Phone numbers and PIN codes are personal data under
India's DPDP Act; they are stored only in `/var/lib/ill-backend/ill.db`, readable only by the
service. Raw activity events are deleted after 400 days (`ILL_RETENTION_DAYS`); leads are kept until
you delete them. Bots and obvious spam submissions are filtered out of the numbers.
