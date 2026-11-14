# Put Tavern Table online

This puts the table on a small rented server with a real address like
`https://table.example.com`, so your friends can join from anywhere.
It takes about 20 minutes.

## 1. Buy two things

- **A server (VPS):** Ubuntu 22.04 or 24.04, 1-2 GB RAM, about 5 USD/month. Any provider works.
- **A domain name** (or use one you own). A subdomain such as `table.yourname.com` is fine.

## 2. Point the domain at the server

In your domain provider's DNS settings, add an **A record**:

- Name: `table` (or `@` for the bare domain)
- Value: the server's IP address (shown in the provider's dashboard)

## 3. Connect to the server

On your computer, open a terminal (Windows: PowerShell) and use your server's IP:

```bash
ssh root@YOUR_SERVER_IP
```

## 4. Run the setup

Replace the domain (and optionally your email, for certificate notices):

```bash
curl -fsSL https://raw.githubusercontent.com/agentmahie1977/tavern-table/main/deploy/setup.sh -o setup.sh
```

```bash
DOMAIN=table.example.com EMAIL=you@example.com bash setup.sh
```

If the first command says "404", the files are not on the `main` branch yet; ask whoever maintains the project.
It prints the address when finished.

## 5. Create the first account

Open `https://table.example.com` in a browser and create an account.
**The first account becomes the owner/DM.** Send the address to your friends so they can make theirs.

## Update

```bash
bash /opt/tavern-table/deploy/update.sh
```

## Back up

```bash
bash /opt/tavern-table/deploy/backup.sh
```

Backups land in `/var/backups/tavern-table` (the newest 14 are kept). To run it every night, run `crontab -e` and add:

```bash
30 3 * * * /opt/tavern-table/deploy/backup.sh >> /var/log/tavern-backup.log 2>&1
```

Copy a backup to your own computer now and then (run this on your computer):

```bash
scp root@YOUR_SERVER_IP:/var/backups/tavern-table/tavern-table-*.tar.gz .
```

## Restore

Stop the app, unpack a backup over the data folder, start it again (use your backup's file name):

```bash
systemctl stop tavern-table
```

```bash
tar -xzf /var/backups/tavern-table/tavern-table-DATE.tar.gz -C /var/lib
```

```bash
chown -R tavern:tavern /var/lib/tavern-table && systemctl start tavern-table
```

## See the logs

```bash
journalctl -u tavern-table -f
```

Press Ctrl+C to stop watching. For the web address/HTTPS side: `journalctl -u caddy -f`.

## Troubleshooting

- **The site doesn't load / certificate error right after setup.** DNS may not be ready yet. Check that the domain points at your server, then wait 5-30 minutes:
  ```bash
  getent hosts table.example.com
  ```
- **Still no HTTPS.** Ports 80 and 443 must be open. Also check your provider's own firewall panel (some block them by default) and allow 22, 80, 443. Then look at `journalctl -u caddy -f`.
- **"502 Bad Gateway".** The app isn't running:
  ```bash
  systemctl status tavern-table
  ```
  Restart it with `systemctl restart tavern-table` and read the logs (above).
- **Locked out of SSH after setup.** The firewall allows only SSH on port 22. If your provider uses another SSH port, use the provider's web console.
