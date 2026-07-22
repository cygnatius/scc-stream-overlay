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
public/js/           modules: config, board, clock, moves, livechess, pgn,
                     pairingsman, scenes, zones, music
config/*.json        all settings; written by the admin page, hot-reloaded
                     by the display within ~half a second (gitignored)
assets/              sponsor logos, player photos, intermission video,
                     background music, club art
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
  auto-filled from the Pairingsman broadcast API (read-only; configured on
  the admin Pairingsman tab, every field switchable auto / manual / hidden).
  The overlay is fully operable with Pairingsman absent — auto degrades to
  the manual values whenever the payload is null or unreachable.

## Background music

The display can play a looping music bed (Admin → **Music**): upload audio
files there (or drop them into `assets/music/` and Rescan), tick the tracks
you want in the rotation, **Save music**, then press **Play**. Shuffle deals
**one** seeded order and loops over it in full — nothing repeats until the
whole library has played — and the order survives display reloads;
**Reshuffle** deals a new order. Volume, **Next track** and play/stop act
immediately, and the bed pauses by itself while an intermission video plays
with sound. Formats: mp3, m4a, aac, ogg, opus, wav, flac.

**How OBS hears it:** the display page itself plays the audio, so it arrives
through the OBS **browser source** — tick **"Control audio via OBS"** on the
overlay source and balance it in the OBS audio mixer (leave monitoring off).
Nothing plays out of the venue speakers and no microphone is involved. If a
second copy of the display is ever added as another OBS source, put
`?music=0` on that copy's URL so the bed isn't doubled into the mix.

**Finding stream-safe music** — the repo ships none, deliberately. Classical
*compositions* are public domain, but most commercial *recordings* of them
are not, and platform content-ID flags those within minutes. Build the
library from places that licence the recording itself:

- **Musopen** — [musopen.org](https://musopen.org) — public-domain / CC
  classical recordings; check the licence shown on each recording.
- **Pixabay Music** — [pixabay.com/music](https://pixabay.com/music/) —
  royalty-free classical and lo-fi, no attribution required.
- **Free Music Archive** — [freemusicarchive.org](https://freemusicarchive.org)
  — filter to CC0 / CC-BY.
- **Kevin MacLeod** — [incompetech.com](https://incompetech.com) — huge CC-BY
  catalogue; credit him in the stream description.

Keep a note of where each file came from, and prefer CC0 / public-domain
recordings for the quietest life on Twitch and YouTube.

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
