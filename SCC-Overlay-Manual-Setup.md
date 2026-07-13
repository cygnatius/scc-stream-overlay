# Shepparton Chess Club — Stream Overlay (Manual) Setup

One file, `scc-stream-overlay-manual.html`. No accounts, no APIs. You type the
players and event into the file; the board, moves and clocks come live from
DGT LiveChess. Copy this one file to whatever machine runs OBS.

---

## 1. Add it to OBS (one-time per machine)

1. Copy `scc-stream-overlay-manual.html` onto the machine and put it somewhere
   stable, e.g. `C:\SCC\scc-stream-overlay-manual.html`.
2. In OBS, under **Sources** click **+ → Browser**, name it, **OK**.
3. Tick **Local file**, **Browse** to the html, set **Width 1920**,
   **Height 1080**, **OK**.
4. You'll see the overlay full-size with a demo game — that's expected until
   you connect the board.

---

## 2. Type in the players and event

Right-click the html → **Open with → Notepad**. Near the middle, under
`►►► EDIT THIS — YOUR PLAYERS AND EVENT ◄◄◄`, set:

```
venue:      "Shepparton Mechanics Institute"
tournament: "Club Championship 2026"
round:      "Round 4"
boardNo:    "Board 1"

white:  name:"Hayden Brennan"  title:""    rating:1685  record:"3½ / 4"
black:  name:"Shulin Walia"    title:"CM"  rating:1802  record:"4 / 4"
```

Leave the `fen`, `moves`, `lastMove`, `toMove` lines alone — the board feed
fills those. Save the file.

---

## 3. Connect the DGT board

Further down, find `const CONFIG` and set **host**:

```
livechess:
  host: "127.0.0.1:1982"     // LiveChess is on the SAME PC as OBS
  // or
  host: "192.168.1.50:1982"  // LiveChess is on a DIFFERENT PC (use its IP)
```

- **Same PC** (LiveChess and OBS together): use `127.0.0.1:1982`.
- **Different PC**: on the LiveChess PC open **Command Prompt**, type `ipconfig`,
  read the **IPv4 Address**, and use that plus `:1982`.

Save the file, then in OBS **right-click the source → Refresh**. The board goes
live.

---

## What must be true

- **DGT LiveChess is running** with the board connected and the game showing.
- If OBS and LiveChess are on **different PCs**: both on the **same network**,
  and port **1982** allowed through the LiveChess PC's firewall.
- The **OBS PC has internet** — the fonts and the move-parsing library load
  online. (The player names you typed do **not** need internet.)

---

## Quick test

1. Overlay shows in OBS at 1920×1080 (demo game) → OBS is good.
2. Set `host`, Refresh → the demo game is replaced by whatever is on your board.
3. Make a move → the board and move list update within ~1 second.

If the board doesn't move: wrong `host`/IP, LiveChess not running, firewall, or
(two-PC setup) not on the same network. Copy one raw LiveChess message and the
parser can be adjusted.

---

## Moving between machines

Copy the same html across and repeat step 1. The only line that changes is
`host` — `127.0.0.1:1982` when LiveChess is on the same PC, or the LiveChess
PC's IP when it's separate. Everything you typed in step 2 travels in the file.
