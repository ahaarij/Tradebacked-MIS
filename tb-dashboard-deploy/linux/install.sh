#!/usr/bin/env bash
# Tradebacked MIS dashboard - installer for Ubuntu / Debian servers (Nginx + login + HTTPS)
#
#   sudo ./linux/install.sh -d mis.example.com -u finance -e it@example.com
#
# Result:
#   https://mis.example.com         dashboard, behind a username/password login
#   /srv/tb-dashboard/inbox         drop a new MIS .xlsx here; the dashboard refreshes within 15 minutes
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: sudo ./linux/install.sh -d DOMAIN -u USERNAME [options]

  -d DOMAIN     hostname users will open, e.g. mis.example.com
                (its DNS A record must point to this server before HTTPS can be issued)
  -u USERNAME   first dashboard login; you will be asked to type its password
  -e EMAIL      email for Let's Encrypt certificate notices
  -a IPS        allow only these IPs / ranges, comma separated (e.g. 203.0.113.10,10.0.0.0/8)
  --no-ssl      skip the HTTPS certificate (testing only, or when TLS ends at a load balancer)
  --no-cron     don't install the 15-minute auto-refresh job

Set TB_PASSWORD in the environment to create the first login without a prompt.
EOF
  exit 1
}

DOMAIN=""; USERNAME=""; EMAIL=""; ALLOW=""; SSL=1; CRON=1
while [ $# -gt 0 ]; do
  case "$1" in
    -d) DOMAIN="${2:-}"; shift 2 ;;
    -u) USERNAME="${2:-}"; shift 2 ;;
    -e) EMAIL="${2:-}"; shift 2 ;;
    -a) ALLOW="${2:-}"; shift 2 ;;
    --no-ssl) SSL=0; shift ;;
    --no-cron) CRON=0; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done
[ -n "$DOMAIN" ] && [ -n "$USERNAME" ] || usage
[ "$(id -u)" -eq 0 ] || { echo "Please run with sudo."; exit 1; }

PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP=${TB_APP:-/opt/tb-dashboard}
WEBROOT=${TB_WEBROOT:-/var/www/tb-dashboard}
INBOX=${TB_INBOX:-/srv/tb-dashboard/inbox}
HTPASSWD=${TB_HTPASSWD:-/etc/nginx/.htpasswd-tb}
SITE_AVAIL=${TB_SITE_AVAIL:-/etc/nginx/sites-available}
SITE_EN=${TB_SITE_EN:-/etc/nginx/sites-enabled}
LOG=${TB_LOG:-/var/log/tb-dashboard.log}

step() { printf '\n==> %s\n' "$*"; }
reload_nginx() {
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet nginx 2>/dev/null; then systemctl reload nginx
  elif pgrep -x nginx >/dev/null 2>&1; then nginx -s reload
  elif command -v systemctl >/dev/null 2>&1 && systemctl enable --now nginx 2>/dev/null; then :
  else nginx
  fi
}

if [[ "$DOMAIN" =~ ^[0-9.]+$ ]] && [ $SSL -eq 1 ]; then
  echo "Note: certificates can't be issued for a bare IP address ($DOMAIN). Continuing without HTTPS."
  echo "      Passwords will travel unencrypted - use a domain name before real use."
  SSL=0
fi

step "Installing packages"
if [ "${TB_SKIP_APT:-0}" != 1 ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  PKGS="nginx apache2-utils python3 python3-openpyxl"
  [ $SSL -eq 1 ] && PKGS="$PKGS certbot python3-certbot-nginx"
  # shellcheck disable=SC2086
  apt-get install -y -q $PKGS
fi

step "Copying dashboard files"
getent group tbmis >/dev/null || groupadd tbmis
mkdir -p "$APP" "$WEBROOT" "$INBOX" "$(dirname "$LOG")"
cp -r "$PKG/build/." "$APP/"
install -m 755 "$PKG/linux/update.sh" "$APP/update.sh"
install -m 644 "$PKG/site/index.html" "$PKG/site/xlsx.full.min.js" "$PKG/site/robots.txt" "$WEBROOT/"
chown root:tbmis "$INBOX"; chmod 2775 "$INBOX"
touch "$LOG"

step "Creating login '$USERNAME'"
CREATE=""; [ -f "$HTPASSWD" ] || CREATE="-c"
if [ -n "${TB_PASSWORD:-}" ]; then
  htpasswd -B -b $CREATE "$HTPASSWD" "$USERNAME" "$TB_PASSWORD"
else
  htpasswd -B $CREATE "$HTPASSWD" "$USERNAME"
fi
chown root:www-data "$HTPASSWD" 2>/dev/null || true
chmod 640 "$HTPASSWD"

step "Configuring Nginx for $DOMAIN"
ALLOW_BLOCK=""
if [ -n "$ALLOW" ]; then
  IFS=',' read -ra IPS <<< "$ALLOW"
  for ip in "${IPS[@]}"; do ALLOW_BLOCK+="    allow ${ip// /};\n"; done
  ALLOW_BLOCK+="    deny  all;"
fi
sed -e "s|__DOMAIN__|$DOMAIN|g" -e "s|__WEBROOT__|$WEBROOT|g" -e "s|__HTPASSWD__|$HTPASSWD|g" \
    "$PKG/linux/tb-dashboard.nginx.conf" |
  awk -v block="$ALLOW_BLOCK" '{ if ($0 ~ /^#__ALLOW__/) { print (block != "" ? block : "    # none - any IP may reach the login page") } else print }' \
  > "$SITE_AVAIL/tb-dashboard"
if [ ! -s /proc/net/if_inet6 ]; then   # host without IPv6: drop the IPv6 listener
  sed -i '/listen \[::\]/d' "$SITE_AVAIL/tb-dashboard"
fi
ln -sf "$SITE_AVAIL/tb-dashboard" "$SITE_EN/tb-dashboard"
nginx -t
reload_nginx

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  step "Opening firewall for web traffic"
  ufw allow 'Nginx Full' || true
fi

if [ $SSL -eq 1 ]; then
  step "Requesting HTTPS certificate for $DOMAIN"
  CERT_ARGS=(--nginx -d "$DOMAIN" --redirect)
  [ -n "$EMAIL" ] && CERT_ARGS+=(--agree-tos -m "$EMAIL" --non-interactive)
  if ! certbot "${CERT_ARGS[@]}"; then
    echo
    echo "!! Certificate request failed. Check that the DNS A record for $DOMAIN points to this server"
    echo "   and that port 80 is open, then run:  sudo certbot --nginx -d $DOMAIN --redirect"
    SSL=0
  fi
fi

if [ $CRON -eq 1 ]; then
  step "Installing auto-refresh (every 15 minutes)"
  cat > /etc/cron.d/tb-dashboard <<EOF
# Rebuild the Tradebacked dashboard when a new MIS workbook lands in $INBOX
*/15 * * * * root $APP/update.sh >> $LOG 2>&1
EOF
  chmod 644 /etc/cron.d/tb-dashboard
fi

SCHEME=http; [ $SSL -eq 1 ] && SCHEME=https
cat <<EOF

--------------------------------------------------------------------
 Tradebacked MIS dashboard is live

   Open:        $SCHEME://$DOMAIN
   Login:       $USERNAME

   Refresh it:  upload the new MIS .xlsx to $INBOX
                (auto-published within 15 minutes, or run: sudo $APP/update.sh)
   Add a user:  sudo htpasswd -B $HTPASSWD <name>
   Remove user: sudo htpasswd -D $HTPASSWD <name>
   Log:         $LOG
--------------------------------------------------------------------
EOF
[ $SSL -eq 1 ] || echo " Warning: running without HTTPS. Add a certificate before sharing the link."
