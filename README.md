# Tavern Table

A live battle map for playing 5e with friends: upload maps, move tokens together,
build heroes, run encounters and initiative, place spell areas, and roll in a shared
dice log. Works on phones and computers.

## Play it

**Online, from a link (easiest):** open **https://agentmahie1977.github.io/tavern-table/**,
then People and settings (top right) → **Host this table online**, and send friends the
invite link. Your browser is the table: keep that tab open while you play. Friends need
nothing but the link. (Uses the free PeerJS lobby to connect browsers; doesn't work when
only Iran's national network is up. Use your own server below for that.)

**On your own computer or server (no accounts, works without the internet):**

1. Install [Node.js](https://nodejs.org) (LTS).
2. Download this repository (green **Code** button → **Download ZIP**) and unzip it.
3. Windows: double-click `start-table.bat`. Mac: double-click `start-table.command`.
   Or run `node server.js --password YOUR_PASSWORD`.
4. Open the address it prints. Friends open the "For friends" address and type the password.

See [HOSTING.md](HOSTING.md) for playing across a home network, from home with a
public IP, or on a small VPS, including on Iran's national network (نت ملی)
during filtering.

**On claude.ai:** publish `index.html` with the `data/` folder as a Claude artifact
with the db, room and user capabilities. Friends with a Claude account join as Editors.

**Solo:** open the page without a server and it runs on that device only.

## Features

- Battle map with map upload, grid calibration, pan/zoom/pinch, live token dragging,
  ruler, pings
- Spell areas (circle, cone, square, line) that find who's inside and apply damage and saves
- Hero builder and sheet: SRD races, classes, backgrounds, spells, attacks, resources,
  death saves, rests
- **Homebrew feats:** write your table's own feats and pick their effects from menus
  (attack trade-offs with an on/off switch, ability and AC bonuses, proficiencies,
  limited-use trackers, wider crit range). Hero sheets apply them automatically.
- Encounter builder with difficulty ratings over the SRD monsters, initiative tracker,
  shared dice log

## Development

```bash
python3 tools/build.py      # rebuild index.html after editing src/
node tools/test_core.js     # rules tests
python3 tools/check.py      # browser check (needs Playwright)
```

Project layout and conventions: [CLAUDE.md](CLAUDE.md).

## License of the rules content

This work includes material taken from the System Reference Document 5.1 ("SRD 5.1")
by Wizards of the Coast LLC, available at
https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is licensed
under the Creative Commons Attribution 4.0 International License
(https://creativecommons.org/licenses/by/4.0/legalcode).
