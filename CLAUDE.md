# Tavern Table

A virtual tabletop for D&D 5e, for a private group of friends (not commercial). Battle map with
uploaded maps and grid calibration, live token movement, spell area templates (circle, cone,
square, line), a 5e character builder and sheet, an SRD encounter builder with difficulty
ratings, initiative tracking, and a shared dice log.

## Layout

- `src/` — the app, plain JS with no framework or bundler
  - `core.js` — pure game logic: dice parser/roller, 5e character derivation, encounter XP math,
    template geometry (which squares an area covers). No DOM; unit-tested in Node.
  - `store.js` — shared state. Uses the claude.ai artifact capabilities `db` (shared documents),
    `room` (presence: who is here, live drags, pings, rulers) and `user` (identity) when present.
    Without them it falls back to **solo mode**: localStorage plus BroadcastChannel, so tabs in
    one browser sync but other devices don't. All writes go through one queue per document.
    View-only viewers' writes are relayed through presence to an open writer's page.
  - `map.js` — the board: pan/zoom/pinch, grid, tokens, templates, ruler, pings, HUD.
  - `ui.js` — panels and sheets: heroes (builder + sheet), encounter, combat, dice log, scenes,
    people/settings, monster stat blocks, spell cards.
  - `main.js` — boot.
  - `style.css`, `body.html` — styles and markup shell.
- `data/` — SRD 5.1 content compacted to JSON (`rules`, `spells`, `monsters`, `features`),
  fetched at runtime from `data/*.json`.
- `server.js` — self-hosted mode, plain Node.js with no dependencies: serves the page and `data/`,
  keeps the shared documents in `table-data/` (map pieces as files), pushes changes and presence over
  server-sent events. `store.js` detects it (`api/hello`) when not inside claude.ai, so one build runs
  in three modes: claude.ai capabilities, self-hosted server, or solo. See `HOSTING.md`.
- `vendor/peerjs.min.js` — PeerJS (MIT) for online play: the host's browser runs a hub over its solo
  storage (`makeHub`), guests join with `#join=<room>` links; both reuse `serverBackend`/`serverRoom`.
  `?broker=host:port/path&broker_secure=0` picks a different PeerJS broker (tests use a local one).
- `docs/` — the GitHub Pages website, written by `tools/build.py` (full page + data + vendor). Commit it.
- `index.html` — built output (page content only; claude.ai adds the doctype/head skeleton).
- `tools/`
  - `build.py` — concatenates `src/*` into `index.html`.
  - `test_core.js` — Node unit tests for `core.js` (run: `node tools/test_core.js`).
  - `check.py` — Playwright end-to-end check: phone solo flow plus three simulated people at
    one table, using `mock_claude.js` as a stand-in for `window.claude`.
  - `prep_srd.py` — regenerates `data/` from the 5e-bits/5e-database repo
    (`python3 tools/prep_srd.py <5e-database>/src/2014/en data`).

## Commands

```bash
python3 tools/build.py          # rebuild index.html after editing src/
node tools/test_core.js         # logic tests
python3 tools/check.py          # browser check (needs: pip install playwright && playwright install chromium)
python3 -m http.server          # then open http://localhost:8000/test.html (solo mode);
                                # check.py writes test.html, a full page wrapping index.html
```

## Conventions

- Escape all user text: build HTML with the `html` tagged template in `ui.js` (auto-escapes);
  wrap trusted markup in `raw()`.
- Nested objects merge on `update`, so to reset a map like spell slots write zeros
  (`zeroKeys()`), not `{}`.
- Campaigns: `S.camp` ("main" keeps the original storage). Solo/host storage keys get `:<id>`;
  the server keeps `table-data/campaigns/<id>/`; claude.ai prefixes paths with `camp/<id>/`.
  Presence carries `cp` so people in other campaigns are filtered out.
- Homebrew (`homebrew/*`, field `kind`): feat, item, spell, monster, subclass, class. `Core.*FromHomebrew`
  / `homebrewClass` convert them to SRD shapes; `mergeHomebrew()` in store.js builds `Data.rules`, `spells`,
  `monsters`, `features` from `Data.srd` + homebrew. `featsFor(ch)` = feats + equipped (and attuned) items +
  homebrew class/subclass features up to the hero's level; their effects go through `Core.derive`.
- Homebrew is game-wide: `isGlobalPath()` keeps `homebrew/*` out of campaign prefixes (claude.ai), in
  the main storage (`splitBackend` for solo/host) and in the main server table (`isGlobal` in server.js).
- SRD class mechanics live in `Core.builtinSources` / `classActions` as the same effect sources homebrew
  uses (Rage, Reckless Attack, Champion, Magical Secrets, Lore, Life domain, fighting styles via `c.styles`).
  Choices a feature or feat asks for are `d.choices`; the player's picks are `c.picks[effectKey]`.
- Inventories: hero `ch.inv` [{id, n, q, note, hb, eq, at}] and `ch.coins`; party items `party/*`,
  party coins `game/state.coins`.
- Shared document paths: `game/state`, `scenes/*`, `tokens/*`, `templates/*`, `chars/*`,
  `init/*`, `encounters/*`, `homebrew/*`, `log/*`, `mapchunks/*` (map images in ~190 KB base64 pieces).
- Content is SRD 5.1 (CC-BY-4.0); keep the attribution in the People and settings sheet.
  Don't paste text from purchased books into the app or `data/`; homebrew entered as mechanics
  plus your own wording is fine.

## Open ideas

- Let the DM role be handed to another player (today each device picks its own role in
  People and settings; the owner defaults to DM).
- Optional SRD 5.2 (2024 rules) dataset.
- Fog of war.
- Self-hosted mode has one shared password and no per-person roles; anyone with it can edit.
