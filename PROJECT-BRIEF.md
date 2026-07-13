# SCC Stream Overlay — Project Brief (handoff for Claude Code)

Paste-friendly context for continuing this project in Claude Code. Open Claude
Code in the repo root and start from here.

## What this is

A broadcast overlay for streaming Shepparton Chess Club games. It's a single
self-contained HTML file — `scc-stream-overlay.html` — loaded as an **OBS
Browser Source** (1920×1080). It renders the live board, move list, clocks and
player cards, themed to match `sheppartonchess.club`.

**One file, one toggle.** `CONFIG.pairingsman.enabled` chooses where the
player/event data comes from:

- `false` (default) — **manual, no external accounts.** You type the
  players/event into the `STATE` block. No secrets in the file.
- `true` — pulls names, ratings, round, tournament and records from the
  Pairingsman v1 API instead (needs `token` + `meetingId`; keep the token out of
  public git).

Either way the board/moves/clocks come live from DGT LiveChess, clocks tick
locally and re-sync on change, and a sponsor area (0/1/many logos, rotating if
several — via `STATE.sponsors`) sits under the move list.

(Earlier there were two separate files, `overlay-manual.html` and
`overlay-pairingsman.html`; they've been consolidated into this one.)

## Architecture

Three independent systems the overlay ties together:

- **DGT boards → DGT LiveChess** (runs on the playing-hall PC): the live board.
  The overlay opens a WebSocket to `ws://<livechess-host>:1982/api/v1.0` and
  polls the `eboards` call (`{id:1,call:"eboards"}`) every ~800ms. Responses
  carry `param[].board` (FEN piece placement), `clock`, `serialnr`, `state`.
- **Pairingsman** (cloud REST, `https://pairingsman.com/api/v1`, bearer token,
  60 req/min): names/round/tournament/record. Joined to the board by the
  pairing's `table` == board number. Poll `/meetings/{id}/pairings` (~10s) and
  `/tournaments/{id}/standings` (~30s). Only in the Pairingsman variant.
- **OBS** composites it: the overlay is a Browser Source; OBS is typically on a
  *different machine* from LiveChess, on the same LAN.

### Key implementation notes (don't relearn these the hard way)

- **chess.js must be a plain-browser global build.** We use
  `cdnjs .../chess.js/0.10.3/chess.min.js`. The 0.13.x / 1.x builds are ES
  modules and throw `Unexpected token 'export'` when loaded as a classic
  `<script>`, leaving `Chess` undefined and the board frozen on demo data.
  Consider bundling chess.js locally so it works without internet.
- **Move list is reconstructed from the FEN stream.** LiveChess sends only the
  piece-placement FEN. We keep a chess.js game and, on each new placement, find
  the single legal move that reaches it (→ SAN, last move, side to move). This
  is robust to the transient positions a DGT board emits mid-move (piece lifted)
  and handles takebacks. If no single move matches and the position settles for
  ~1.2s, we snap to it (mid-game join / desync fallback).
- **Clocks: the DGT clock feed only changes at move-end.** So the overlay ticks
  the side-to-move down locally every second and re-syncs to the real DGT value
  *only when it changes* (tracked via `LC_LAST_W/LC_LAST_B`). Re-applying the
  feed value every poll (the naive version) freezes the display — don't do that.
- **Fixed 1920×1080 canvas, scaled to fit.** `.stage` is 1920×1080; a `fitStage()`
  scales it to the window so it previews in a browser and renders 1:1 in OBS.
- **`ws://` from a local file works; from HTTPS it does not.** A browser blocks
  insecure WebSockets from a secure (HTTPS) page, so the live overlay cannot be
  served from GitHub Pages — keep it a local file in OBS. Pages is demo-only.

### Theme (matches the website)

- Background aubergine `#2E2028`, darker `#1F151B`; parchment `#F1E7D3`;
  gold `#D9A13B`; brick `#A9603F`.
- Fonts: **Sitka** (wordmark / small-caps labels — ships with Windows),
  **Playfair Display** (display headings), **Figtree** (body/data).
- Logo: `https://sheppartonchess.club/img/light/Clear.png` (dark emblem, sits on
  the cream crest tile).
- Board squares: light `#E7D6B4`, dark `#6B4B39`. Pieces are the solid Unicode
  glyphs, coloured cream (white) / dark (black) with an outline for contrast.

## Current status

- Manual mode **working live** on the test setup: board mirrors the DGT board,
  move list builds, clock ticks and syncs. Verified with LiveChess at
  `192.168.0.92:1982`.
- **Player + moves reworked**: the two player cards now flank the board (Black
  above, White below) and the move list runs the full height of the right
  column.
- **Sponsor area** added under the moves (`STATE.sponsors`: 0 hides it, 1 is
  static, many auto-rotate).
- **Consolidated to one file** with the `pairingsman.enabled` toggle; the
  ticking-clock fix now lives in that single file (was open task #3).

## Open tasks

1. **Finalise the Pairingsman "record" field** — mapping is a best-guess
   (`points`/`games`); confirm against a real `/tournaments/{id}/standings`
   response and fix the field names.
2. **Confirm the exact LiveChess `clock` field shape** and adjust `lcClockSec`
   if needed (currently handles string `H:MM:SS` or numeric ms/seconds).
3. **Bundle chess.js locally** for offline reliability at venues.
4. **Verify the consolidated file on the real venue setup** (LiveChess + OBS) in
   both toggle states — it's only been checked in the dev browser so far.

## Testing reality

Neither Claude Code nor Cowork can test the live pipeline from the dev machine —
LiveChess + OBS are separate machines. Author here; reload on the venue setup to
verify. Console (F12) on the OBS/browser machine is the debugging surface.

## Kickoff line for Claude Code

> Read PROJECT-BRIEF.md and README.md. The overlay works in manual mode; next I
> want to [describe the change]. It's one file with a `pairingsman.enabled`
> toggle — keep both modes working and don't commit my Pairingsman token.
