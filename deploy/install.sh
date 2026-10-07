#!/usr/bin/env bash
# One-command setup for ill.gtplkcbpl.com on a fresh Ubuntu 22.04 / 24.04 (or Debian 12) server.
#
#   curl -fsSL https://raw.githubusercontent.com/rishirajrateria/GTPL/claude/ecstatic-mccarthy-sj43jp/deploy/install.sh | sudo bash
#
# What it does: installs nginx, certbot and Python; puts the page in /var/www/ill.gtplkcbpl.com; installs
# the leads/analytics service in /opt/ill-backend with a generated admin password; configures nginx; and,
# if DNS already points here, turns on HTTPS. Safe to run again: it updates the files and keeps the
# password, the secret and all collected data.
#
# Optional settings (put them before "bash", e.g. "... | sudo ILL_EMAIL=you@example.com bash"):
#   ILL_EMAIL   e-mail for Let's Encrypt expiry notices
#   ILL_REF     git branch or commit to install (default: the branch named above)
set -euo pipefail

DOMAIN=ill.gtplkcbpl.com
REPO=rishirajrateria/GTPL
REF=${ILL_REF:-claude/ecstatic-mccarthy-sj43jp}
RAW="https://raw.githubusercontent.com/$REPO/$REF"
WEBROOT=/var/www/$DOMAIN
APPDIR=/opt/ill-backend
ENVFILE=/etc/ill-backend.env
PWFILE=/root/ill-admin-password.txt

public_ip() {
  { curl -4 -fsS --max-time 8 https://api.ipify.org || curl -4 -fsS --max-time 8 https://ifconfig.me \
      || hostname -I | awk '{print $1}'; } 2>/dev/null
}
say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mXX %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run it as root: put 'sudo' before 'bash'."
command -v apt-get >/dev/null || die "This script needs Ubuntu or Debian."
command -v systemctl >/dev/null || die "This script needs systemd."

say "Installing nginx, certbot and Python (takes a minute or two)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx certbot python3-certbot-nginx python3 curl ca-certificates >/dev/null
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' || die "Python 3.8 or newer is needed."

say "Downloading the site from github.com/$REPO ($REF)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
fetch() { curl -fsSL --retry 3 "$RAW/$1" -o "$TMP/$(basename "$1")" || die "Could not download $1"; }
for f in index.html favicon.svg og-image.jpg robots.txt sitemap.xml \
         server/ill_backend.py server/admin.html server/ill-backend.service \
         deploy/nginx/$DOMAIN.conf; do
  fetch "$f"
done
grep -q '<title>' "$TMP/index.html" || die "Downloaded index.html looks wrong."

say "Installing the page in $WEBROOT"
install -d -m 755 "$WEBROOT"
for f in index.html favicon.svg og-image.jpg robots.txt sitemap.xml; do
  install -m 644 "$TMP/$f" "$WEBROOT/$f"
done

say "Installing the leads and analytics service in $APPDIR"
install -d -m 755 "$APPDIR"
install -m 644 "$TMP/ill_backend.py" "$APPDIR/ill_backend.py"
install -m 644 "$TMP/admin.html" "$APPDIR/admin.html"
install -m 644 "$TMP/ill-backend.service" /etc/systemd/system/ill-backend.service

if [ -s "$ENVFILE" ] && grep -q '^ILL_ADMIN_PASSWORD_HASH=.' "$ENVFILE"; then
  echo "Keeping the existing admin password and settings in $ENVFILE"
  NEWPW=""
else
  NEWPW=$(python3 -c 'import secrets,string; a=string.ascii_letters+string.digits; print("".join(secrets.choice(a) for _ in range(16)))')
  HASH=$(ILL_PW="$NEWPW" python3 -c 'import os,sys; sys.path.insert(0,"'"$APPDIR"'"); import ill_backend as b; print(b.hash_password(os.environ["ILL_PW"]))')
  SECRET=$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')
  umask 077
  cat > "$ENVFILE" <<EOF
# Settings for ill-backend. Restart after editing: systemctl restart ill-backend
ILL_ADMIN_PASSWORD_HASH=$HASH
ILL_SECRET=$SECRET

# Optional: e-mail an alert for every new lead
#ILL_NOTIFY_TO=sales@gtplkcbpl.com
#ILL_SMTP_HOST=smtp.example.com
#ILL_SMTP_PORT=587
#ILL_SMTP_STARTTLS=1
#ILL_SMTP_USER=
#ILL_SMTP_PASSWORD=
#ILL_SMTP_FROM=
EOF
  printf '%s\n' "$NEWPW" > "$PWFILE"
  chmod 600 "$ENVFILE" "$PWFILE"
  umask 022
fi

systemctl daemon-reload
systemctl enable ill-backend >/dev/null 2>&1
systemctl restart ill-backend
for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl -fsS http://127.0.0.1:8787/api/health >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS http://127.0.0.1:8787/api/health >/dev/null 2>&1 \
  || { journalctl -u ill-backend -n 20 --no-pager || true; die "The service did not start (log above)."; }

say "Configuring nginx"
CONF=/etc/nginx/sites-available/$DOMAIN.conf
if [ -f "$CONF" ] && grep -q 'managed by Certbot' "$CONF"; then
  echo "HTTPS is already set up in $CONF; leaving the nginx config as it is."
else
  install -m 644 "$TMP/$DOMAIN.conf" "$CONF"
  ln -sf "$CONF" "/etc/nginx/sites-enabled/$DOMAIN.conf"
  # The stock "Welcome to nginx" site would answer instead of ours for some requests.
  if [ -L /etc/nginx/sites-enabled/default ]; then rm -f /etc/nginx/sites-enabled/default; fi
  if ! nginx -t >/dev/null 2>&1; then
    sed -i '/listen \[::\]:80;/d' "$CONF"     # servers without IPv6
  fi
fi
nginx -t >/dev/null 2>&1 || { nginx -t; die "nginx rejected the configuration (details above)."; }
systemctl enable nginx >/dev/null 2>&1
systemctl reload nginx 2>/dev/null || systemctl restart nginx

# Open the firewall if ufw is switched on (it is off on most fresh cloud servers).
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q 'Status: active'; then
  ufw allow 'Nginx Full' >/dev/null
fi

# ---- HTTPS: a small command that can be run now or once DNS points here
EMAIL_DEFAULT=${ILL_EMAIL:-}
cat > /usr/local/sbin/ill-https <<EOF
#!/usr/bin/env bash
# Turns on HTTPS for $DOMAIN once its DNS record points to this server.
set -euo pipefail
IP=\$( { curl -4 -fsS --max-time 8 https://api.ipify.org || curl -4 -fsS --max-time 8 https://ifconfig.me || hostname -I | awk '{print \$1}'; } 2>/dev/null )
DNS=\$(getent ahostsv4 $DOMAIN | awk 'NR==1{print \$1}' || true)
if [ "\$DNS" != "\$IP" ]; then
  echo "$DOMAIN points to '\${DNS:-nothing yet}', but this server is \$IP."
  echo "Ask for the DNS record (A  ill  \$IP), wait 5-10 minutes, then run: sudo ill-https"
  exit 2
fi
EMAIL_ARGS=(--register-unsafely-without-email)
EMAIL=\${ILL_EMAIL:-$EMAIL_DEFAULT}
if [ -n "\$EMAIL" ]; then EMAIL_ARGS=(-m "\$EMAIL"); fi
certbot --nginx -d $DOMAIN --redirect --non-interactive --agree-tos "\${EMAIL_ARGS[@]}"
sed -i 's|# add_header Strict-Transport-Security|add_header Strict-Transport-Security|' /etc/nginx/sites-available/$DOMAIN.conf
nginx -t && systemctl reload nginx
echo
echo "HTTPS is on: https://$DOMAIN   (admin: https://$DOMAIN/admin)"
EOF
chmod 755 /usr/local/sbin/ill-https

say "Checking"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $DOMAIN" http://127.0.0.1/)
[ "$code" = 200 ] || die "The page did not load locally (HTTP $code)."
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $DOMAIN" http://127.0.0.1/api/health)
[ "$code" = 200 ] || die "The form service is not reachable through nginx (HTTP $code)."
echo "Page and form service both answer."

IP=$(public_ip)
HTTPS_DONE=0
set +e; /usr/local/sbin/ill-https >/tmp/ill-https.log 2>&1; rc=$?; set -e
if [ "$rc" = 0 ]; then HTTPS_DONE=1
elif [ "$rc" != 2 ]; then warn "DNS already points here but HTTPS setup failed:"; tail -n 15 /tmp/ill-https.log; fi

printf '\n\033[1;32m%s\033[0m\n' "============================================================"
printf '\033[1;32m  Done. The site is installed on this server.\033[0m\n'
printf '\033[1;32m%s\033[0m\n\n' "============================================================"
echo "  Server IP (send this to Arun):   $IP"
echo "  DNS record he should add:        A   ill   $IP   (TTL 300)"
echo
if [ -n "$NEWPW" ]; then
  echo "  Admin password:                  $NEWPW"
  echo "  (Save it now. It is also in $PWFILE on this server: sudo cat $PWFILE)"
else
  echo "  Admin password:                  unchanged (sudo cat $PWFILE if you still have it)"
fi
echo
if [ "$HTTPS_DONE" = 1 ]; then
  echo "  HTTPS is on. Open https://$DOMAIN and https://$DOMAIN/admin"
else
  echo "  NEXT: after Arun adds the record, wait 5-10 minutes and run:   sudo ill-https"
  echo "  That turns on HTTPS. Then open https://$DOMAIN/admin"
fi
echo
