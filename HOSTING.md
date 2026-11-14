# Hosting Tavern Table yourself

One computer runs the table. Everyone else opens its address in a browser
(phone or computer) and types the table password. Nobody needs an account,
and nothing comes from outside Iran, so it keeps working on نت ملی when the
international internet is cut, as long as your friends can reach that computer.

## Do this BEFORE the internet is filtered

1. Download **Node.js** (the "LTS" installer from nodejs.org) and install it on the
   computer that will run the table. Keep the installer file too, in case you
   need to reinstall.
2. Keep this whole `tavern-table` folder on that computer.

That's all. The server uses no extra packages and never connects to the internet.

## Start a game

- **Windows:** double-click `start-table.bat`, type a password, press Enter.
- **Mac:** double-click `start-table.command` (the first time, right-click it and
  choose Open). On Linux run `./start-table.command`.
- Or from a terminal: `node server.js --password YOUR_PASSWORD` (add `--port 3000`
  to use another port).

The window prints the addresses to use, for example:

```
On this computer:   http://localhost:8080
For friends:        http://192.168.1.20:8080
```

Open `http://localhost:8080` on the host computer. Opened that way, you're the
**DM** automatically. Friends open the "For friends" address and type the password.
Keep the window open while you play. The game is saved in the `table-data` folder
as you go, so closing the window (or a power cut) loses nothing. Start it again and
everyone's screen reconnects by itself.

## Where should the server run?

**1. Everyone in the same house / same Wi‑Fi.** Always works. Use the
`192.168…` address the window prints.

**2. Friends in different places, host at home.** Your friends need to reach your
home internet from outside. That only works if:

- your internet line has a **public IP address**. Many Iranian home and especially
  mobile connections don't (they share one address between many customers).
  Some ISPs sell a static/public IP for fixed lines (ADSL/VDSL/fiber).
- you **forward the port** (8080) on your router to the host computer (router
  settings → Port Forwarding / Virtual Server).

Then friends use `http://YOUR-PUBLIC-IP:8080`. Test this on a normal day first:
ask a friend on another network to open it. If it doesn't load, your line probably
has no public IP, so use option 3.

**3. A small Iranian server (VPS). Most reliable.** Rent the cheapest Linux VPS
from a provider inside Iran (Iranian data centers stay reachable on نت ملی during
shutdowns). On it: install Node.js, copy this folder over, and run

```
node server.js --password YOUR_PASSWORD --port 8080
```

Keep it running after you log out with `nohup node server.js --password YOUR_PASSWORD &`,
or set it up as a service. Friends use `http://VPS-IP:8080`. Open port 8080 in the
provider's firewall if it has one.

## Good to know

- **The password** is the only lock. Anyone with the address and password can move
  tokens, roll and edit heroes. Don't post it publicly. The connection is plain
  HTTP, so someone on the same network could see it. That's fine for a friends'
  game, but don't reuse a password you use anywhere else.
- **Backups:** copy the `table-data` folder. To start a fresh campaign, stop the
  server and move that folder somewhere else.
- **Phones:** fully supported. Add the page to the home screen for a full-screen view.
- **Fonts:** the self-hosted page uses the device's own fonts, since Google Fonts
  isn't reachable during filtering.
- **The same files still work on claude.ai.** Inside a Claude artifact the page uses
  Claude's shared storage instead of this server.

## Public server with accounts (VPS + HTTPS)

For a server on the open internet, use accounts instead of one shared password:

```
node server.js --accounts --trust-proxy --host 127.0.0.1 --port 8080
```

- Everyone opens the address and **creates an account** (name + password of at least
  8 characters). They stay signed in on that device for 60 days.
- The **first account made is the table owner and a DM**: make yours before you share
  the address. In People and settings the owner can reset anyone's password and make
  people DMs or players.
- The server checks every change: players edit only their own heroes, tokens, templates,
  homebrew and dice rolls; scenes, maps, encounters, monster pictures, combat and the
  shown scene belong to DMs; backup and restore belong to the owner.
- Passwords are kept as scrypt hashes in `table-data/users.json` (with the sign-in
  sessions). It never leaves the server; keep it out of shared copies of the folder.
- Put an HTTPS reverse proxy (Caddy, nginx) in front and forward to `127.0.0.1:8080`.
  `--trust-proxy` makes the server read the visitor's address and https from the
  proxy's `X-Forwarded-For` / `X-Forwarded-Proto` headers, so only use it behind a proxy
  that sets them. Turn off response buffering for `/api/events` (live updates), e.g.
  nginx `proxy_buffering off;`. Caddy: `reverse_proxy 127.0.0.1:8080` is enough.
- Anyone who finds the address can create a (player) account, so share it only with
  your group. Sign-in attempts are limited to 10 per 5 minutes per address.
