/* rabbit-feed.js — the board, read from RabbitConnect's own window.

   WHY THIS EXISTS (3 Oct 2026 meet). The DGT board has ONE serial port (COM4)
   and exactly one program can hold it. RabbitConnect and DGT LiveChess both
   want it; whichever starts first wins and the other gets nothing. The overlay
   reads the board through LiveChess — so on a day the operator streams with
   RabbitConnect (its board and clock windows captured in OBS), LiveChess has
   no board and the overlay sits on the last position it was given.

   This tool lets both run. RabbitConnect keeps the port and stays on stream;
   we look at the board diagram it draws (tools/rabbit-capture.ps1 — passive,
   no input sent, port untouched) and serve what we read in the LiveChess
   `eboards` shape on ws://127.0.0.1:1983/api/v1.0. The display needs no
   change: point it here with Board → manual host override → 127.0.0.1:1983.

   WHAT IT WILL NOT DO. It never guesses. RabbitConnect draws its board with a
   chess font, so every piece is the same pixels every time; a square is read
   only when its ink matches one piece template (or is empty) almost exactly.
   One unreadable square rejects the whole frame, and with no good frame for
   OFFLINE_AFTER_MS the board is reported INACTIVE with a null source — the
   same "LiveChess has lost the board" shape the display already holds on.

   THE CLOCKS come from RabbitConnect's driver window ("DGT RabbitPlugin"),
   which keeps both times as text and updates them every second whether or
   not the window is showing. They are passed on in LiveChess's shape — see
   "clocks" below. No readable times → clock: null, and the display shows
   none rather than invent.

   It reads the diagram AS DRAWN, a8 top-left. If RabbitConnect is set to show
   the board rotated, this reads it rotated.

     node tools/rabbit-feed.js                 serve on 127.0.0.1:1983
     node tools/rabbit-feed.js --port 1990     … on another port
     node tools/rabbit-feed.js --once          print one reading and exit
     GET /_state                               what it sees, as JSON

   Zero deps: node http + crypto + child_process, and Windows PowerShell. */
"use strict";
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const TEMPLATES = JSON.parse(fs.readFileSync(path.join(__dirname, "rabbit-templates.json"), "utf8"));
const TILE = TEMPLATES.tile;                 // px per square in RabbitConnect's diagram
const INK_BELOW = TEMPLATES.ink_below;       // luminance under this is piece ink; the hatching is lighter
const MATCH_MAX = 12;                        // a square may differ from its template by this many ink px
const PIECES = Object.keys(TEMPLATES.pieces).map((p) => ({ p, bits: unpack(TEMPLATES.pieces[p]) }));

const OFFLINE_AFTER_MS = 3000;               // no good reading for this long → board reported gone
const EMPTY_BOARD = "8/8/8/8/8/8/8/8";

function unpack(b64) {
  const packed = Buffer.from(b64, "base64"), bits = new Uint8Array(TILE * TILE);
  for (let i = 0; i < bits.length; i++) bits[i] = (packed[i >> 3] >> (7 - (i & 7))) & 1;
  return bits;
}
function pack(bits) {
  const packed = Buffer.alloc(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) if (bits[i]) packed[i >> 3] |= 1 << (7 - (i & 7));
  return packed.toString("base64");
}

/* An EMPTY square still has to look like part of the diagram: a dark square
   is hatched (313 shaded px on the venue PC), a light one is clean (1). A
   window that painted blank, or a picture of something else entirely, has no
   ink either — without this it would read as sixty-four empty squares. */
const SHADE_BELOW = 230;
const DARK_EMPTY_MIN_SHADE = 200;
const LIGHT_EMPTY_MAX_SHADE = 30;

// The ink of one square: 1 where the pixel is dark enough to be a piece.
function tileInk(lum, w, file, row) {
  const bits = new Uint8Array(TILE * TILE);
  let n = 0, shade = 0;
  for (let y = 0; y < TILE; y++) {
    const base = (row * TILE + y) * w + file * TILE;
    for (let x = 0; x < TILE; x++) {
      const v = lum[base + x];
      if (v < SHADE_BELOW) shade++;
      if (v < INK_BELOW) { bits[y * TILE + x] = 1; n++; }
    }
  }
  return { bits, n, shade };
}
function distance(a, b) { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] ^ b[i]; return d; }

/* One frame → a placement, or a reason there is none. `lum` is the
   RabbitConnect client area as luminance bytes, row-major, w×h; the diagram
   sits in its top-left corner. Every one of the 64 squares must be readable. */
function readPlacement(lum, w, h) {
  if (w < TILE * 8 || h < TILE * 8 || lum.length < w * h) return { ok: false, reason: "window too small (" + w + "x" + h + ")" };
  const rows = [], unreadable = [];
  for (let r = 0; r < 8; r++) {
    let row = "", gap = 0;
    for (let f = 0; f < 8; f++) {
      const t = tileInk(lum, w, f, r);
      let piece = null;
      if (t.n > MATCH_MAX) {
        let best = null, bestD = Infinity;
        for (const c of PIECES) { const d = distance(t.bits, c.bits); if (d < bestD) { bestD = d; best = c.p; } }
        if (bestD <= MATCH_MAX) piece = best;
        else { unreadable.push("abcdefgh"[f] + (8 - r)); continue; }
      } else {
        const dark = (f + r) % 2 === 1;
        if (dark ? t.shade < DARK_EMPTY_MIN_SHADE : t.shade > LIGHT_EMPTY_MAX_SHADE) { unreadable.push("abcdefgh"[f] + (8 - r)); continue; }
      }
      if (piece) { if (gap) { row += gap; gap = 0; } row += piece; } else gap++;
    }
    if (gap) row += gap;
    rows.push(row);
  }
  if (unreadable.length) return { ok: false, reason: "cannot read " + unreadable.slice(0, 6).join(" ") + (unreadable.length > 6 ? " +" + (unreadable.length - 6) : "") };
  return { ok: true, placement: rows.join("/") };
}

// Build templates from a frame whose position is known (how rabbit-templates.json was made).
function learn(lum, w, h, placement) {
  const rows = placement.split("/").map((r) => r.replace(/\d/g, (d) => ".".repeat(+d)));
  const pieces = {};
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const p = rows[r][f];
    if (p !== "." && !pieces[p]) pieces[p] = pack(tileInk(lum, w, f, r).bits);
  }
  return pieces;
}

/* ---- the same diagram, as text ------------------------------------------
   RabbitConnect's diagram is eight one-line controls of chess-font text, and
   the helper reads those too. Lower case is a piece on a light square, upper
   case the same piece on a dark one; "*" and "+" are the empty light and dark
   squares. Captured at the venue, 3 Oct 2026:  *+lT*V*T / OoO*+oOo / …
   Every character has to be one we know AND sit on the right colour of
   square, so a row of anything else is refused.
   For now this is a CROSS-CHECK only (/_state says whether it agrees with the
   picture): seven of the twenty-six characters have not been seen at the
   venue yet, and the picture reading was checked by eye. */
const TEXT_PIECES = { p: "P", n: "N", b: "B", r: "R", q: "Q", k: "K", o: "p", m: "n", v: "b", t: "r", w: "q", l: "k" };
function readRows(rows) {
  if (!Array.isArray(rows) || rows.length !== 8) return { ok: false, reason: "no rows" };
  const out = [];
  for (let r = 0; r < 8; r++) {
    const s = String(rows[r]);
    if (s.length !== 8) return { ok: false, reason: "row " + (8 - r) + " is not 8 squares" };
    let row = "", gap = 0;
    for (let f = 0; f < 8; f++) {
      const ch = s[f], dark = (f + r) % 2 === 1;
      if (ch === "*" || ch === "+") {
        if ((ch === "+") !== dark) return { ok: false, reason: "wrong square colour at " + "abcdefgh"[f] + (8 - r) };
        gap++;
        continue;
      }
      const lower = ch.toLowerCase(), piece = TEXT_PIECES[lower];
      if (!piece) return { ok: false, reason: "unknown character at " + "abcdefgh"[f] + (8 - r) };
      if ((ch !== lower) !== dark) return { ok: false, reason: "wrong square colour at " + "abcdefgh"[f] + (8 - r) };
      if (gap) { row += gap; gap = 0; }
      row += piece;
    }
    if (gap) row += gap;
    out.push(row);
  }
  return { ok: true, placement: out.join("/") };
}

/* ---- clocks --------------------------------------------------------------
   RabbitConnect shows each clock ticking, second by second. The display was
   built for LiveChess, which only changes a clock value when a move ENDS: it
   counts the side to move down itself, and it works out how long each move
   took from one move-end value to the next. Hand it a value every second and
   it would measure every move as taking about a second.
   So this speaks LiveChess's dialect. While a clock is counting down we keep
   reporting the value it STARTED its turn with; when it stops we report where
   it stopped. A stop is known two ways: the OTHER clock is seen ticking (the
   press — declared at once), or no tick for STOP_MS (a pause, nobody's clock
   started). Anything that is not an ordinary tick — an increment, a reset, a
   clock being set — is passed on at once.

   WHICH CLOCK IS TICKING is also passed on, as `ticking`: "w" | "b" | null.
   This is not LiveChess's `run` flag (whose meaning differs by firmware and
   which the display learnt to ignore): it is the clock digits themselves, read
   from RabbitConnect every few hundred ms, going down. The display ticks the
   side RabbitConnect's clock says is ticking, so a press moves the tick even
   when the move engine has lost whose turn it is (24 Oct 2026 meet). */
const CLOCK_RE = /^\d{1,2}:\d{2}:\d{2}$/;
const TICK_MAX_S = 3;                        // a drop of 1–3 s between looks is the clock ticking
const STOP_MS = 2500;                        // no tick for this long: it has stopped
function clockSec(s) {
  if (typeof s !== "string" || !CLOCK_RE.test(s)) return null;
  const p = s.split(":").map(Number);
  return p[0] * 3600 + p[1] * 60 + p[2];
}
const fmtClock = (t) => Math.floor(t / 3600) + ":" + String(Math.floor((t % 3600) / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");

function makeClockShaper() {
  const side = { w: { raw: null, shown: null, tickAt: 0 }, b: { raw: null, shown: null, tickAt: 0 } };
  function observe(c, sec, now) {
    const s = side[c], other = side[c === "w" ? "b" : "w"];
    if (sec == null) { s.raw = null; s.shown = null; s.tickAt = 0; return; }
    if (s.raw == null) { s.raw = sec; s.shown = sec; s.tickAt = 0; return; }   // first sight: as it stands
    if (sec !== s.raw) {
      const down = s.raw - sec;
      if (down >= 1 && down <= TICK_MAX_S) {                                   // ticking: keep showing the turn's starting value
        s.tickAt = now;
        // A chess clock runs one side at a time, so the first tick seen here
        // IS the press: the other clock has stopped, where it stands is its
        // move-end value, and it goes out now rather than STOP_MS later.
        if (other.tickAt) { other.shown = other.raw; other.tickAt = 0; }
      }
      else { s.shown = sec; s.tickAt = 0; }                                    // set / reset / increment: pass it on
      s.raw = sec;
    }
    if (s.tickAt && now - s.tickAt > STOP_MS) { s.shown = s.raw; s.tickAt = 0; }   // stopped: this is the move-end value
  }
  // Which clock was last seen ticking and has not stopped since. Both can
  // hold a tick time only for the instant between a press and the next look,
  // and then the later tick is the one that is running.
  function running() {
    const w = side.w.tickAt, b = side.b.tickAt;
    if (!w && !b) return null;
    return b > w ? "b" : "w";
  }
  // The LiveChess `clock` object, or null when there is nothing honest to send.
  function field() {
    const w = side.w, b = side.b;
    if (w.shown == null || b.shown == null) return null;
    // Both at zero is a clock that is off or not set, not two flags down at
    // once — and a zero is what makes the display sound the flagfall.
    if (w.raw === 0 && b.raw === 0) return null;
    return { white: fmtClock(w.shown), black: fmtClock(b.shown), ticking: running() };
  }
  return {
    observe, field, running,
    raw: () => ({ w: side.w.raw, b: side.b.raw }),
  };
}

module.exports = { readPlacement, learn, readRows, clockSec, makeClockShaper, TILE, INK_BELOW, STOP_MS };
if (require.main !== module) return;

/* ------------------------------------------------------------------ run */
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] || true) : null; };
const PORT = Number(flag("--port")) || 1983;
const ONCE = args.includes("--once");
const LEARN = flag("--learn");               // --learn <placement>: print templates for the frame on screen

// Report the same serial the overlay is configured for, so its move model
// carries straight over when the operator switches feeds mid-game.
let SERIAL = "RabbitConnect";
try {
  const b = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "board.json"), "utf8"));
  if (b.serialnr != null && b.serialnr !== "") SERIAL = String(b.serialnr);
} catch (e) { }

const state = {
  placement: null,                           // last good reading
  readAt: 0,                                 // when a frame last read cleanly (epoch ms)
  changedAt: 0,                              // when the placement last changed
  helper: "starting",                        // what the capture helper last said
  frames: 0, rejected: 0, lastReject: null, helperRestarts: 0,
  textAt: 0,                                 // when RabbitConnect's text fields were last read
  clockText: { top: null, bottom: null },    // the two clock fields, verbatim
  status: null,                              // RabbitConnect's own board status ("Board alive")
  textPlacement: null, textReason: null,     // the diagram read as text (cross-check)
  textChecks: 0, textDisagreed: 0,
};
const clocks = makeClockShaper();
const online = () => state.placement != null && Date.now() - state.readAt < OFFLINE_AFTER_MS;
// The clock fields are only as fresh as the last text line from the helper.
const clockField = () => (Date.now() - state.textAt < OFFLINE_AFTER_MS ? clocks.field() : null);

/* T <8 rows, main window> <8 rows, driver window> <top clock> <bottom clock> <status>
   The diagram is drawn black-at-the-top, so the top clock is Black's. */
function onText(line) {
  const f = line.split("\t");
  if (f.length < 20) return;
  const now = Date.now();
  state.textAt = now;
  state.clockText = { top: f[17], bottom: f[18] };
  state.status = f[19] || null;
  clocks.observe("b", clockSec(f[17]), now);
  clocks.observe("w", clockSec(f[18]), now);
  const mainRows = f.slice(1, 9), driverRows = f.slice(9, 17);
  const t = readRows(mainRows.some((r) => r) ? mainRows : driverRows);
  state.textPlacement = t.ok ? t.placement : null;
  state.textReason = t.ok ? null : t.reason;
}

let helper = null, tail = "", restartMs = 1000;
function startHelper() {
  helper = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "rabbit-capture.ps1")],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  helper.stdout.setEncoding("utf8");
  helper.stdout.on("data", (d) => {
    tail += d;
    let i;
    // Strip only the line ending: a text line's last field may be empty, and its tabs matter.
    while ((i = tail.indexOf("\n")) >= 0) { const line = tail.slice(0, i).replace(/\r$/, ""); tail = tail.slice(i + 1); if (line) onLine(line); }
  });
  helper.stderr.on("data", (d) => { state.helper = "helper error: " + String(d).trim().slice(0, 120); });
  helper.on("exit", () => {
    helper = null; tail = "";
    state.helper = "helper stopped";
    state.helperRestarts++;
    if (!ONCE) setTimeout(startHelper, restartMs);
    restartMs = Math.min(10000, restartMs * 2);
  });
}

function onLine(line) {
  if (line[0] === "T" && line[1] === "\t") { onText(line); return; }
  if (line === "=") {                        // picture unchanged: the last reading still stands
    if (state.helper === "reading") {
      state.readAt = Date.now();
      // a settled picture and the text beside it should say the same thing
      if (state.textPlacement) { state.textChecks++; if (state.textPlacement !== state.placement) state.textDisagreed++; }
    }
    return;
  }
  if (line[0] === "X") { state.helper = line.slice(2); return; }
  if (line[0] !== "F") return;
  const sp1 = line.indexOf(" ", 2), sp2 = line.indexOf(" ", sp1 + 1);
  const w = Number(line.slice(2, sp1)), h = Number(line.slice(sp1 + 1, sp2));
  const lum = Buffer.from(line.slice(sp2 + 1), "base64");
  restartMs = 1000;
  state.frames++;
  if (LEARN) {
    console.log(JSON.stringify({ tile: TILE, ink_below: INK_BELOW, pieces: learn(lum, w, h, String(LEARN)) }, null, 1));
    process.exit(0);
  }
  const r = readPlacement(lum, w, h);
  if (!r.ok) {
    state.rejected++; state.lastReject = r.reason;
    state.helper = "unreadable: " + r.reason;
    if (ONCE) { console.log("UNREADABLE — " + r.reason); process.exit(2); }
    return;
  }
  state.helper = "reading";
  state.readAt = Date.now();
  if (r.placement !== state.placement) {
    state.placement = r.placement;
    state.changedAt = state.readAt;
    console.log(new Date().toTimeString().slice(0, 8) + "  " + r.placement);
  }
  if (ONCE) process.exit(0);
}

startHelper();
if (ONCE) { setTimeout(() => { console.log("NO READING — " + state.helper); process.exit(2); }, 15000); return; }

function boardMsg(id) {
  const up = online();
  return JSON.stringify({
    response: "call", id: id == null ? 1 : id,
    param: [{
      serialnr: SERIAL,
      source: up ? "RabbitConnect" : null,
      state: up ? "ACTIVE" : "INACTIVE",
      battery: null, comment: null,
      // Offline: the last position actually read, or an empty board — never a stand-in.
      board: state.placement || EMPTY_BOARD,
      flipped: false,
      clock: up ? clockField() : null,
    }],
    time: Date.now(),
  });
}

const server = http.createServer((req, res) => {
  const p = (req.url || "/").split("?")[0];
  if (p === "/_state") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({
      online: online(), placement: state.placement, helper: state.helper,
      read_age_ms: state.readAt ? Date.now() - state.readAt : null,
      changed_age_ms: state.changedAt ? Date.now() - state.changedAt : null,
      frames: state.frames, rejected: state.rejected, last_reject: state.lastReject,
      helper_restarts: state.helperRestarts, clients: sockets.size, serial: SERIAL,
      clock: {
        sent: clockField(),                          // what the overlay is being told
        rabbit: { black: state.clockText.top, white: state.clockText.bottom },   // what RabbitConnect shows right now
        ticking: clocks.running(),
        text_age_ms: state.textAt ? Date.now() - state.textAt : null,
      },
      rabbit_status: state.status,
      text_check: { placement: state.textPlacement, reason: state.textReason, agrees: state.textPlacement != null && state.textPlacement === state.placement, checks: state.textChecks, disagreed: state.textDisagreed },
    }));
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });   // no PGN here — the overlay's probe reads "absent"
  res.end("not found");
});

/* Hand-rolled WebSocket, as in tools/fake-livechess.js: drain every masked
   client frame in the buffer and carry a partial one over to the next chunk. */
const sockets = new Set();
server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => sockets.delete(socket));
  let acc = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    acc = acc.length ? Buffer.concat([acc, chunk]) : chunk;
    for (;;) {
      if (acc.length < 2) break;
      const len7 = acc[1] & 0x7f;
      let off = 2, len = len7;
      if (len7 === 126) { if (acc.length < 4) break; len = acc.readUInt16BE(2); off = 4; }
      else if (len7 === 127) { if (acc.length < 10) break; len = Number(acc.readBigUInt64BE(2)); off = 10; }
      const masked = (acc[1] & 0x80) !== 0;
      const need = off + (masked ? 4 : 0) + len;
      if (acc.length < need) break;
      const opcode = acc[0] & 0x0f;
      let body = acc.slice(off + (masked ? 4 : 0), need);
      if (masked) {
        const mask = acc.slice(off, off + 4);
        const out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) out[i] = body[i] ^ mask[i % 4];
        body = out;
      }
      acc = acc.slice(need);
      if (opcode === 0x8) { try { socket.end(Buffer.from([0x88, 0x00])); } catch (e) { } return; }   // close: answer it, then hang up
      if (opcode !== 0x1) continue;
      try {
        const msg = JSON.parse(body.toString("utf8"));
        if (msg.call === "eboards") send(socket, boardMsg(msg.id));
      } catch (e) { /* ignore malformed */ }
    }
  });
});

function send(socket, text) {
  const payload = Buffer.from(text, "utf8");
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  try { socket.write(Buffer.concat([header, payload])); } catch (e) { }
}

server.on("error", (e) => { console.error("rabbit-feed: " + e.message); process.exit(1); });
server.listen(PORT, "127.0.0.1", () => {
  console.log("rabbit-feed: reading RabbitConnect's board, serving ws://127.0.0.1:" + PORT + "/api/v1.0  (serial " + SERIAL + ")");
  console.log("Leave this window open. Point the overlay here: admin → Board → manual host override → 127.0.0.1:" + PORT);
});
process.on("exit", () => { try { if (helper) helper.kill(); } catch (e) { } });
