# Shepparton Chess Club — Stream Overlay Setup

One file, `scc-stream-overlay.html`, is the whole overlay. It shows a demo game until you
point it at your live data. Copy this one file to whatever machine runs OBS — that's all
that has to travel.

---

## The three systems (who does what)

- **OBS machine** — runs OBS + this overlay. This changes: your test PC now, the live PC later.
- **LiveChess PC** — runs DGT LiveChess with the board plugged in. Supplies the board, moves
  and clocks. The overlay reaches it over the **local network**.
- **Pairingsman** — the cloud API. Supplies player names, ratings, round, tournament and
  records over the **internet**.

The overlay joins them: LiveChess draws the board, Pairingsman fills the name/round/rating cards.

---

## One-time setup on an OBS machine

1. Copy `scc-stream-overlay.html` onto the machine (USB stick, or email it to yourself).
   Put it somewhere it won't move, e.g. `C:\SCC\scc-stream-overlay.html`.
2. Open **OBS**. Under **Sources** click **+ → Browser**, name it "Chess overlay", **OK**.
3. Tick **Local file**, **Browse** to the html, set **Width 1920**, **Height 1080**, **OK**.
4. You'll see the overlay full-size showing the demo game. OBS setup is done.

---

## Before each event: fill in CONFIG

Right-click `scc-stream-overlay.html` → **Open with → Notepad**. Near the bottom find
`const CONFIG = {` and set these values:

```
boardNumber: 1,                         // the table this overlay is for (usually 1)

pairingsman:
  token:      "7|abcdef..."             // your Bearer token (mint once, see below)
  meetingId:  210                       // tonight's meeting id from Pairingsman

livechess:
  host: "192.168.1.50:1982"             // the LiveChess PC's LAN address (see below)
```

**Save** the file, then in OBS **right-click the source → Refresh**. Live data now flows.

### Finding the LiveChess PC's LAN address
On the **LiveChess PC**, open **Command Prompt** and type `ipconfig`. Read the **IPv4 Address**
(looks like `192.168.x.x`). Put that plus `:1982` into `host`. Do **not** use `localhost` — the
overlay is on a different machine.

### Minting the Pairingsman token (once)
On the Pairingsman server (Forge → Run Command):
```
php artisan api:token you@example.com --name="obs-overlay"
```
It prints the token once — copy it immediately. Reuse the same token on every machine.

---

## What must be true at the venue

- The **LiveChess PC and the OBS PC are on the same network**, and port **1982** is allowed
  through the LiveChess PC's firewall.
- **DGT LiveChess is running** with the board connected and the game showing.
- The **OBS PC has internet** — Pairingsman, the fonts, and the move-parsing library all load
  online. No internet means no names/records and the board won't draw.

---

## Moving from the test machine to the live machine

Identical each time: copy the same html across and do the "one-time setup" above. The only
CONFIG line that normally changes is **`livechess.host`**, because the LiveChess PC's IP is
different on a different network. `token` and `boardNumber` stay the same; update `meetingId`
per event.

Tip: keep two copies if it helps — `scc-overlay-TEST.html` and `scc-overlay-LIVE.html` — each
with its own `host` already set, so you don't edit at the venue.

---

## Quick test checklist

1. Overlay shows in OBS at 1920×1080 (demo game) → **OBS is good**.
2. Fill CONFIG, Refresh → names / round / tournament change to the real ones → **Pairingsman is good**.
3. Make a move on the board → the overlay board + move list update within ~1 second → **LiveChess is good**.

### If something's off
- **Names stay on the demo** → wrong token or meetingId, or a CORS block from the browser
  source. Send Hayden's Claude a note and it'll supply a tiny local proxy for the token.
- **Board doesn't move** → wrong `host`/IP, firewall blocking 1982, or the two PCs aren't on
  the same network. Copy one raw LiveChess `eboards` message and the parser can be adjusted.
- **Records show "—"** → standings field names differ from the guess; paste one
  `/tournaments/{id}/standings` response to finalise them.

---

## Keep this file private

It holds your Pairingsman token. Don't publish it or host it on a public web address. As a
local OBS browser-source file on your own PC, it's fine.
