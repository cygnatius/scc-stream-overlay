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
and **Black** labels: name, optional title (CM, WFM…), optional rating, and
the record as **wins / draws / losses** (three number fields). It shows on
stream as `4–1–2` (W–D–L), or `1–4` when there are no draws, and nothing at
0/0/0 — same look as before, now driven by the numbers. Or skip typing:

**Players tab** — keep a club **roster** (name, photo, rating, W/D/L). Press
**→ White** / **→ Black** on a roster row to drop that player straight into
the match fields, photo and record included. Photos upload here (or drop
files into `assets/players/` and Rescan). The **photo policy** picks photos +
initials avatars, photos only, or no photos at all.

**Live tab → Matches (the run sheet)** — stage the meet's games ahead of
time, players picked from the roster by dropdown. Per match: **DGT** (it will
run on the board), **show** (advertise it in the zones), a status (upcoming /
in progress / complete), the result once complete, an optional label
("Championship Bd 1"), and — while in progress — an optional material note
("White +2"). Point any zone slot at **Matches — run sheet** (Sponsors &
Zones) and the staged games appear on the start / versus / postgame bands and
beside the game, feature (DGT) games distinguished with the gold edge and tag,
records shown from the roster. When the main event begins, press **▶ Go live**
on its row: the two players load into the live area automatically and the
game-start sequence runs — then the result buttons complete that match on the
sheet (and Undo puts it back).

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

**Music & FX tab** — the looping background bed. Upload audio files (or drop
them into `assets/music/` and Rescan), tick the ones for the rotation, **Save
music**, press **Play**. Play/stop, volume, **Next track** and **Reshuffle**
act immediately — no save needed. Shuffle plays one fixed shuffled order in
full before it repeats; Reshuffle deals a new order. The bed pauses by itself
while an intermission video plays with sound, and the "Now:" line (plus the
Music pill up top) shows exactly what the display is playing. OBS must have
**"Control audio via OBS"** ticked on the overlay source (see the setup doc) —
the music then rides the browser source into the mixer, with the room silent.

The same tab holds **Result effects** (off by default): when a result lands —
the featured game's result on the postgame scene, or a data zone's content
changing (other boards' results, standings, pairings) — the display can pop /
pulse the element and play a cue. The built-in chime, bell and blip need no
files; custom one-shots go in `assets/sfx/`. **Preview** plays a sound right
in admin while you choose; **Test** fires the saved cue on the display so you
can see it exactly as the stream would.

And **Move sounds** (on by default): chess.com-style cues as the game plays —
move, check, checkmate, stalemate and flagfall — each mutable or pointed at a
custom sound, with one volume. Flagfall only fires when the **DGT feed** hands
over a clock at zero, so a display clock that just looks empty never triggers
it.

---

## During the broadcast — the Live tab

- **Scene buttons** — start · versus · game · postgame · intermission ·
  ending. Gold = on air now. Switching manually always works and cancels any
  running sequence.
- **Sequences** — *Game start* plays versus for 8 s then lands on the game;
  *Game end* plays postgame for 40 s then goes straight to intermission.
  Timings are in the Transitions tab. A live readout counts the current phase
  down, and **Stop here** freezes on whatever is showing.
- **Automatic switching** (optional, off by default) — the board itself
  proposes game start / game end (first move played; mate/stalemate; both
  kings placed on the centre squares). Every proposal shows at the top with a
  countdown and a **Cancel** button before it fires. A board disconnect
  withdraws proposals rather than firing them.
- **Result & game end** — press **White wins** / **Draw** / **Black wins** the
  moment the game ends. One click does three things: it records the result
  against the two players (winner +1 win, loser +1 loss; a draw is +1 each, so
  White 2–0 & Black 1–1 becomes White 3–0 & Black 1–2 on a White win), sets the
  postgame result, and starts the game-end sequence. The records update live on
  the postgame scene. **Undo last** reverses it and returns to the game; a
  double-click is ignored so you can't count a game twice. **Set label only**
  writes just the postgame text (e.g. "White wins on forfeit") without touching
  records.
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
