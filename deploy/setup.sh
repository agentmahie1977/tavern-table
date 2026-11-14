#!/usr/bin/env bash
# One-time (and safe to re-run) setup for Tavern Table on Ubuntu 22.04/24.04.
# Usage (as root):  DOMAIN=table.example.com [EMAIL=you@example.com] bash setup.sh
set -euo pipefail

REPO="https://github.com/agentmahie1977/tavern-table"
APP_DIR="/opt/tavern-table"
DATA_DIR="/var/lib/tavern-table"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run this as root (use: sudo -E bash setup.sh)." >&2
  exit 1
fi
if [ -z "${DOMAIN:-}" ]; then
  echo "ERROR: DOMAIN is not set. Example: DOMAIN=table.example.com bash setup.sh" >&2
  exit 1
fi
EMAIL="${EMAIL:-}"
export DEBIAN_FRONTEND=noninteractive

echo "==> Installing base packages"
apt-get update -y
apt-get install -y curl git ca-certificates gnupg ufw debian-keyring debian-archive-keyring apt-transport-https

echo "==> Node.js 20 (NodeSource)"
node_major=""
if command -v node >/dev/null 2>&1; then
  node_major="$(node -v | sed 's/^v//; s/\..*//')"
fi
if [ "$node_major" != "20" ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "==> Caddy (official apt repo)"
if ! command -v caddy >/dev/null 2>&1; then
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "==> User and folders"
if ! id tavern >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin tavern
fi
mkdir -p "$DATA_DIR"
chown tavern:tavern "$DATA_DIR"
chmod 750 "$DATA_DIR"

echo "==> Code"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO" "$APP_DIR"
fi
# Code is owned by root and read-only for the service; only the data folder is writable.
chown -R root:root "$APP_DIR"
chmod -R go+rX "$APP_DIR"

echo "==> Service"
install -m 644 "$APP_DIR/deploy/tavern-table.service" /etc/systemd/system/tavern-table.service
systemctl daemon-reload
systemctl enable tavern-table
systemctl restart tavern-table

echo "==> Caddy config for $DOMAIN"
tmp="$(mktemp)"
if [ -n "$EMAIL" ]; then
  printf '{\n\temail %s\n}\n\n' "$EMAIL" > "$tmp"
else
  : > "$tmp"
fi
# Escape characters special to sed's replacement (\ & |)
domain_esc="$(printf '%s' "$DOMAIN" | sed 's/[\\&|]/\\&/g')"
sed "s|DOMAIN_PLACEHOLDER|$domain_esc|g" "$APP_DIR/deploy/Caddyfile" >> "$tmp"
install -m 644 "$tmp" /etc/caddy/Caddyfile
rm -f "$tmp"
systemctl enable caddy
systemctl restart caddy

echo "==> Firewall (only 22, 80, 443; port 8080 stays closed)"
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo
echo "Done. Open: https://$DOMAIN"
echo "The first account you create there becomes the owner/DM."
echo "(If the page does not load yet, the domain's DNS may still be updating; wait a few minutes.)"
