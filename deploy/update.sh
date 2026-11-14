#!/usr/bin/env bash
# Pull the latest Tavern Table code and restart. Run as root: bash /opt/tavern-table/deploy/update.sh
set -euo pipefail
APP_DIR="/opt/tavern-table"

git -C "$APP_DIR" pull --ff-only
install -m 644 "$APP_DIR/deploy/tavern-table.service" /etc/systemd/system/tavern-table.service
systemctl daemon-reload
systemctl restart tavern-table
sleep 1
systemctl --no-pager --lines=5 status tavern-table || true
echo "Updated."
