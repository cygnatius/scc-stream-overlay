# Shepparton Chess Club — Stream Overlay

Broadcast overlay for streaming club chess games. A single self-contained HTML
file — `scc-stream-overlay.html` — loaded as an **OBS Browser Source**
(1920×1080). It renders the live board, move list, clocks and player cards,
themed to the club site, with the live game coming from **DGT LiveChess**.

Player/event data comes from one of two sources, chosen by a single toggle:

| `pairingsman.enabled` | Where players / round / record come from | Needs a token |
|-----------------------|-------------------------------------------|---------------|
| `false` (default) | You type them into the `STATE` block | No |
| `true` | Pairingsman v1 API (auto-filled) | Yes (keep private) |

Either way, the board / moves / clocks come live from DGT LiveChess, and a
sponsor area (0, 1, or many logos — rotating if several) sits under the moves.

## Quick start (OBS)

1. In OBS: **Sources → + → Browser**, tick **Local file**, choose
   `scc-stream-overlay.html`, set **1920×1080**.
2. Open the file in a text editor and fill the `CONFIG` block near the bottom:
   - `livechess.host` — the LiveChess PC's address. Same PC as OBS →
     `127.0.0.1:1982`; different PC → its LAN IP, e.g. `192.168.0.92:1982`.
   - `pairingsman.enabled` — leave `false` to type players by hand; set `true`
     (and fill `token` + `meetingId`) to auto-fill from Pairingsman.
3. In manual mode (`enabled:false`), type the players/event in the `STATE` block.
   Add sponsor logos to the `STATE.sponsors` array (empty = no sponsor panel).
4. Save, then right-click the source → **Refresh**.

Full walkthroughs are in `docs/`.

## Requirements at the venue

- DGT LiveChess running with the board connected.
- If OBS and LiveChess are on different PCs: same network, port **1982** open.
- Internet on the OBS PC (fonts + the chess library load online — see brief
  about bundling locally).

## Important constraints

- **Don't commit the Pairingsman token.** Only matters once you set
  `pairingsman.enabled:true` and fill in a `token`. Keep this repo private, or
  keep the token out of git. With the toggle off, the file has no secrets.
- **Don't serve the live overlay from GitHub Pages.** An HTTPS page can't open an
  insecure `ws://` connection to LiveChess. Git is for managing the files; OBS
  loads them as local files.

## Development

See `PROJECT-BRIEF.md` for architecture, the hard-won implementation notes, and
the open task list. Testing happens on the venue setup (LiveChess + OBS), not the
dev machine.

## License

MIT — see `LICENSE`. Other DGT clubs are welcome to use and adapt it.
