# Shepparton Chess Club — Stream Overlay Setup (venue)

The overlay is a small local web server plus two pages: the **display** (what
OBS shows) and the **admin** (what you drive the broadcast from). Everything —
board, clocks, moves, scenes, sponsors, video — is controlled from the admin
page in a browser while live. Nothing is edited in Notepad and OBS is never
touched mid-broadcast.

**The whole system runs on the one streaming PC.** LiveChess, OBS and the
overlay server all live on the same machine, so nothing depends on the venue
network and the tethered internet connection changing IP changes nothing.

---

## One-time setup on the streaming PC

1. Install **Node.js** (nodejs.org, the LTS installer, all defaults). This is
   the only thing to install — the overlay has zero other dependencies and
   never downloads anything.
2. Copy this whole project folder somewhere stable, e.g. `C:\SCC\overlay\`.
3. Double-click **`start-overlay.bat`**. A window opens and prints:
   - Display (OBS): `http://127.0.0.1:8420/display.html`
   - Admin: `http://127.0.0.1:8420/admin.html`
   Leave this window open while streaming; Ctrl+C (or closing it) stops the
   overlay.
4. In **OBS**: **Sources → + → Browser**, name it "Chess overlay", **OK**. Then:
   - **Untick "Local file"** and put `http://127.0.0.1:8420/display.html` in
     **URL** (this is the big change from the old single-file overlay — a URL,
     not a file, which is what lets admin changes appear live with no refresh).
   - **Width 1920, Height 1080**.
   - Leave **"Shutdown source when not visible" UNCHECKED** — scene
     transitions animate only while the source is rendered.
   - Tick **"Control audio via OBS"** — the background music bed
     (Admin → Music) then comes through the OBS audio mixer, where its level
     is set. It never plays out of the PC speakers and needs no microphone.
5. Open the admin URL in any browser on the same PC. You're set up.

---

## Connecting the board

DGT LiveChess runs on this same PC, so the overlay connects to
`127.0.0.1:1982` automatically — there is **no IP address to look up or set**.

- Put the board's **serial number** in **Admin → Board** (it's on the sticker
  under the board, and shown inside LiveChess).
- With LiveChess running and the board plugged in, the Board tab shows
  **connected** and the display draws the live position. Until then the
  display shows a clean empty board — never an error — and retries quietly.

**Two-machine fallback** (only if LiveChess must run on a different PC): tick
**Admin → Board → Override the LiveChess host** and enter that PC's address,
e.g. `192.168.1.50:1982`. Both PCs must be on the same network with port 1982
allowed through the LiveChess PC's firewall. Turn the override off to return
to the normal single-machine setup.

---

## What must be true at the venue

- The `start-overlay.bat` window is open (the server is running).
- DGT LiveChess is running with the board connected.
- That's it. Fonts, the chess library and all artwork are vendored inside the
  project — **no internet is needed to render the overlay**. (Internet is only
  used for the stream itself, and later for the optional Pairingsman feed.)

---

## Quick test checklist

1. OBS shows the overlay at 1920×1080 with an empty board and the funder
   credit → **OBS + server are good**.
2. Admin → status pills show **Config API OK** and **Display live** → **the
   pages are talking**.
3. Enter the board serial, start LiveChess, place the pieces → the position
   appears; make a move → board + move list update within a second →
   **LiveChess is good**.
4. Change the round in **Admin → Event** and Save → the display header updates
   within half a second, mid-game, without touching the board → **you're
   broadcast-ready**.

### If something's off

- **Empty board, "not connected" in admin** → LiveChess isn't running, the
  board isn't in it, or the serial in Admin → Board doesn't match.
- **"Config API unreachable" in admin** → the server window was closed;
  double-click `start-overlay.bat` again. The display holds its last state
  through a server restart and recovers on its own.
- **Port already in use** when starting → an overlay window is already open
  somewhere; use it, or set `SCC_PORT` and restart.
- **Demo banner showing in admin** → demo mode is on (fake players on the
  display). It's a design aid — turn it off before going live; it can never
  turn itself on.
- **No music on the stream** → check the Music pill / Now line in admin
  (Admin → Music): "blocked" only happens in a normal browser tab, never in
  OBS; "no tracks" means nothing is ticked and saved; silence with
  "playing" showing means "Control audio via OBS" isn't ticked on the
  browser source, or its mixer fader is down.

---

## Moving to another machine

Copy the whole folder, install Node once, repeat the OBS browser-source step.
Config travels inside the folder (`config/*.json`). If the Pairingsman token
has been set up, treat the folder as private — the token lives in config.
