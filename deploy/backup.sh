#!/usr/bin/env bash
# Back up all Tavern Table data to /var/backups/tavern-table, keeping the last 14.
# Run as root. To run it every night at 03:30, add this line with `crontab -e`:
#   30 3 * * * /opt/tavern-table/deploy/backup.sh >> /var/log/tavern-backup.log 2>&1
set -euo pipefail
DATA_DIR="/var/lib/tavern-table"
DEST="/var/backups/tavern-table"

mkdir -p "$DEST"
chmod 700 "$DEST"
file="$DEST/tavern-table-$(date +%Y-%m-%d-%H%M%S).tar.gz"
tar -czf "$file" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"
echo "Saved $file"

# Keep the newest 14 backups, delete the rest.
ls -1t "$DEST"/tavern-table-*.tar.gz | tail -n +15 | while IFS= read -r old; do
  rm -f -- "$old"
done
