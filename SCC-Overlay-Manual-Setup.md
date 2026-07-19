# Shepparton Chess Club — Running a Broadcast from the Admin Page

Everything is operated from `http://127.0.0.1:8420/admin.html` in a normal
browser while the stream runs. Every save lands on the display within half a
second, mid-game, with no flicker, no board reset and no OBS refresh. No
accounts and no internet are needed — this is the fully manual mode, and it
always works even when Pairingsman is offline or not configured.

(First-time machine setup — Node, OBS, the board — is in
**SCC-Overlay-Setup.md**. This page is the operator's guide.)

---

## Before the game

**Event tab** — event title, season, round, time control, table, running
times (they feed the *start* scene), social links for the footer, and the
"next broadcast" block shown on the *ending* scene (auto-computed weekly by
default; switch to manual to type a date, or hide it).

**Live tab → Match** — type the two players in under the literal **White**
and **Black** labels: name, optional title (CM, WFM…), optional rating,
optional record (`1–4` and `4–1–2` styles both fine). Or skip typing:

**Players tab** — keep a club **roster** (name, photo, rating, record). Press
**→ White** / **→ Black** on a roster row to drop that player straight into
the match fields, photo included. Photos upload here (or drop files into
`assets/players/` and Rescan). The **photo policy** picks photos + initials
avatars, photos only, or no photos at all.

**Sponsors & Zones tab** — sponsor records (name, tier, logo, message) and
the zone layout: left / centre / right, each whole or split top + bottom.
Open scenes (start, versus, postgame, ending) show every column as a bottom
band; the **game scene shows the right column under the moves**, with the
council funder credit kept beneath it. An active zone with no tier assigned
shows a designed "advertise here" invitation. Keep at most four slots active —
admin warns above four. The optional **game-scene bottom strip** relocates
all three columns into a strip above the footer; off (the default) the game
scene renders exactly as it always has.

**Intermission tab** — drop video files into `assets/video/`, Rescan, pick
one. Chapters (time offsets) make the "back from break" resume start from the
chapter that was interrupted, so the whole video eventually airs; exact /
rewind / restart modes are there too.

---

## During the broadcast — the Live tab

- **Scene buttons** — start · versus · game · postgame · intermission ·
  ending. Gold = on air now. Switching manually always works and cancels any
  running sequence.
- **Sequences** — *Game start* plays versus for 8 s then lands on the game;
  *Game end* plays postgame 40 s → start 150 s → intermission. Timings are in
  the Transitions tab. A live readout counts the current phase down, and
  **Stop here** freezes on whatever is showing.
- **Automatic switching** (optional, off by default) — the board itself
  proposes game start / game end (first move played; mate/stalemate; both
  kings placed on the centre squares). Every proposal shows at the top with a
  countdown and a **Cancel** button before it fires. A board disconnect
  withdraws proposals rather than firing them.
- **Postgame result** — press `1–0` / `½–½` / `0–1` the moment the game ends
  (they write immediately), or type anything ("White wins on forfeit") and
  **Set**.
- **Demo mode** — shows the built-in fake game for designing scenes and
  sponsor layouts with no board present. A persistent banner shows in admin
  while it's on; the stream shows no indicator. Turn it off before going live.

The status pills at the top always show: config API, display heartbeat,
LiveChess connection, the scene on air, and what the board detector currently
believes (with its confidence). If the server or board drops, the display
holds its last good state and recovers by itself — nothing on stream goes
blank.

---

## Transitions tab

Default transition (fade, 1000 ms out of the box), per-type defaults, a
per-scene override on entering each scene (cut / fade / crossfade / slide /
wipe, with direction for slide and wipe), sequence dwell times, and the
cancel-window length for automatic transitions.

---

## The golden rules

- The `start-overlay.bat` window stays open. Everything else is the admin page.
- Save buttons go live in ~half a second; nothing needs a refresh.
- The board never resets from config edits — only changing the board serial
  (a different physical board) restarts move tracking.
- The council funder credit stays on unless deliberately toggled off — the
  wording is the required grant acknowledgement; get council sign-off before
  changing it.
