#!/bin/sh
# Mac / Linux: double-click (Mac) or run ./start-table.command
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "Node.js is not installed. Install it, then run this again."; read -r _; exit 1; }
printf "Choose a table password for your friends: "
read -r PW
node server.js --password "$PW"
