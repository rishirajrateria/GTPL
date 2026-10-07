# Launching ill.gtplkcbpl.com

The GTPL KCBPL Business Leased Line page is a **single static page**: no database, no build step,
no server-side code. Going live is DNS, one virtual host, HTTPS and five files.

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

## 3. Web server

Use whichever the server already runs. Both configs were tested on nginx 1.24 and Apache 2.4.

### nginx

```sh
sudo cp nginx/ill.gtplkcbpl.com.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/ill.gtplkcbpl.com.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

If the server has no IPv6, delete the `listen [::]:80;` line.

### Apache

```sh
sudo a2enmod headers deflate expires
sudo cp apache/ill.gtplkcbpl.com.conf /etc/apache2/sites-available/
sudo a2ensite ill.gtplkcbpl.com
sudo apachectl configtest && sudo systemctl reload apache2
```

## 4. HTTPS

Once DNS resolves to the server, issue a free certificate. This also adds the http→https redirect:

```sh
sudo certbot --nginx  -d ill.gtplkcbpl.com --redirect    # nginx
sudo certbot --apache -d ill.gtplkcbpl.com --redirect    # Apache
```

If you already hold a wildcard certificate for `*.gtplkcbpl.com`, add a 443 block using it
instead. Once HTTPS works, uncomment the `Strict-Transport-Security` line in the config and reload.

## 5. Check it

```sh
curl -sI https://ill.gtplkcbpl.com/ | head -1                       # HTTP/2 200 (or HTTP/1.1 200)
curl -sI http://ill.gtplkcbpl.com/  | grep -i location               # redirects to https
curl -s -o /dev/null -w '%{http_code}\n' https://ill.gtplkcbpl.com/data/   # 404 or 403, never 200
```

Then in a browser: the page loads with the logo, the tab shows the globe icon, and tapping a sector
lists its clients. Paste the link into WhatsApp to confirm the preview image appears.

## Updating later

Replace `index.html` (and any changed file) in the web root. No restart is needed; the page is
served with `no-cache`, so visitors get the new version on their next load.

## Open item before launch

**The "Check availability" form does not send enquiries anywhere yet.** It validates and shows a
thank-you message, but the PIN code and phone number are discarded. It needs an endpoint: an email
address, a CRM webhook, or a small script on this server. Search `index.html` for
`TODO: wire form` to find the spot.
