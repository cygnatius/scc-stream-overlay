# Shepparton Chess Club — Stream Overlay

Broadcast overlay for streaming club chess games, rendered by OBS from a tiny
local web server. It shows the live board, clocks, move list, player cards,
a six-scene broadcast flow (start / versus / game / postgame / intermission /
ending), sponsor zones and the council funder credit — all themed to the club
site, with the live game coming from **DGT LiveChess** and everything operated
from a browser **admin page** while on air.

```
server.js            zero-dependency local server (node http/fs/path only)
                     binds 127.0.0.1:8420 — never exposed to the network
public/display.html  the OBS browser source (1920×1080)
public/admin.html    the operator control panel (open in a normal browser)
public/js/           modules: config, board, clock, moves, livechess, scenes, zones
config/*.json        all settings; written by the admin page, hot-reloaded
                     by the display within ~half a second (gitignored)
assets/              sponsor logos, player photos, intermission video, club art
vendor/              Vue 3, chess.js 0.10.3, fonts — fully vendored
start-overlay.bat    double-click launcher; prints the two URLs
```

**No build step, no npm installs, no internet required during a broadcast** —
every dependency is vendored because the venue streams over mobile tethering.

## Quick start

1. Install [Node.js](https://nodejs.org) (any recent LTS) — the only requirement.
2. Double-click **`start-overlay.bat`** (or run `node server.js`). Leave the
   window open.
3. In OBS: **Sources → + → Browser**, untick *Local file*, URL
   `http://127.0.0.1:8420/display.html`, **1920×1080**. Leave *Shutdown source
   when not visible* **unchecked**.
4. Open `http://127.0.0.1:8420/admin.html` in a normal browser and run the
   broadcast from there — scenes, players, event details, sponsors, video.

Changes made in admin appear on the stream within half a second. No file
editing, no OBS refresh. Full venue walkthrough: **SCC-Overlay-Setup.md**;
operating the admin page: **SCC-Overlay-Manual-Setup.md**.

## Live data

- **Board / clocks / moves** — DGT LiveChess over its websocket. LiveChess
  runs on the same machine, so the default `127.0.0.1:1982` just works; a
  manual host override in admin covers the two-machine fallback.
- **Players / event** — typed in admin (roster with photos supported), or
  auto-filled from the Pairingsman broadcast API once that integration stage
  lands. The overlay is fully operable with Pairingsman absent.

## The legacy single file

`scc-stream-overlay.html` at the repo root is the previous self-contained
overlay, kept untouched as the working reference until the served system has
been venue-verified. Its setup docs described editing a `CONFIG` block by
hand — that workflow is retired by the admin page.

## Keep private

`config/pairingsman.json` will hold a bearer token once the Pairingsman stage
is in use. `config/*.json` is gitignored for exactly that reason — don't
commit config, and don't publish a copy of the folder with config in it.

## License

MIT — see `LICENSE`. Other DGT clubs are welcome to use and adapt it.
