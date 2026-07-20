/* Fake DGT LiveChess — DEV TOOL ONLY, never served or loaded by the overlay.
   Lets the whole pipeline (feed, clocks, per-move times, PGN reconciliation,
   scene auto-detection) be exercised with no venue hardware:  node tools/fake-livechess.js
   ws://127.0.0.1:1982/api/v1.0  eboards protocol (placement + clocks)
   GET /pgn        the PGN file (mode-dependent)
   GET /_advance   play the next scripted move
   GET /_back      take the last move back
   GET /_reset     board back to the start position
   GET /_mode?m=agree|clkless|off|diverge|ambiguous
   GET /_state     debug
   Zero deps: node http + crypto + the vendored chess.js. */
"use strict";
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { Chess } = require(path.join(__dirname, "..", "vendor", "chess-0.10.3.min.js"));

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";
const INIT_SEC = 5400;                       // 1:30:00 both sides

// scripted game: SAN + seconds the mover spent (observed truth)
const SCRIPT = [
  { san: "e4", spent: 10 },
  { san: "e5", spent: 7 },
  { san: "Nf3", spent: 63 },
  { san: "Nc6", spent: 12 },
  { san: "Bb5", spent: 95 },
];
// PGN claims slightly different thinks for plies 2..4 (proves PGN precedence)
const PGN_SPENT = [10, 7, 64, 13, 96];

let played = 0;                              // plies on the "physical board"
let mode = "off";                            // /pgn behaviour

function replay(n) {
  const c = new Chess();
  const clocks = { w: INIT_SEC, b: INIT_SEC };
  for (let i = 0; i < n; i++) {
    c.move(SCRIPT[i].san);
    clocks[i % 2 === 0 ? "w" : "b"] -= SCRIPT[i].spent;
  }
  return { placement: c.fen().split(" ")[0], clocks };
}

const fmt = (s) => Math.floor(s / 3600) + ":" + String(Math.floor((s % 3600) / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");

function boardMsg() {
  const { placement, clocks } = replay(played);
  return JSON.stringify({
    response: "call", id: 1,
    param: [{
      serialnr: "3000150100", state: "ACTIVE",
      board: placement,
      clock: { white: fmt(clocks.w), black: fmt(clocks.b), run: played > 0 },
    }],
  });
}

/* ---- PGN builders ---- */
function movetext(sans, spents, withClk, skipClkPly) {
  const c = { w: INIT_SEC, b: INIT_SEC };
  let out = "";
  for (let i = 0; i < sans.length; i++) {
    if (i % 2 === 0) out += (i / 2 + 1) + ". ";
    out += sans[i];
    c[i % 2 === 0 ? "w" : "b"] -= spents[i];
    if (withClk && i !== skipClkPly) out += " {[%clk " + fmt(c[i % 2 === 0 ? "w" : "b"]) + "]}";
    out += " ";
  }
  return out + "*";
}
const game2 = '[Event "Fake Open"]\n[White "Other A"]\n[Black "Other B"]\n[Result "*"]\n\n1. d4 {[%clk 1:29:40]} d5 {[%clk 1:29:35]} 2. c4 {[%clk 1:29:00]} *\n';

function pgnFile() {
  const sans = SCRIPT.slice(0, played).map(m => m.san);
  const head = '[Event "Fake Club Night"]\n[White "John Smith"]\n[Black "Jane Doe"]\n[Result "*"]\n\n';
  if (mode === "agree") return head + movetext(sans, PGN_SPENT, true, -1) + "\n" + game2;
  if (mode === "clkless") return head + movetext(sans, PGN_SPENT, true, 3) + "\n" + game2;   // ply 3 unclocked
  if (mode === "diverge") {
    const bad = sans.slice(); if (bad.length >= 4) bad[3] = "Nf6";                            // conflicts at ply 3
    return head + movetext(bad, PGN_SPENT, true, -1) + "\n" + game2;
  }
  if (mode === "ambiguous") {                                                                // two matches, clks differ
    const a = head + movetext(sans, PGN_SPENT, true, -1);
    const b = head + movetext(sans, SCRIPT.map(m => m.spent), true, -1);
    return a + "\n" + b + "\n";
  }
  return null;                                                                               // off → 404
}

/* ---- HTTP + hand-rolled WebSocket ---- */
const sockets = new Set();

const server = http.createServer((req, res) => {
  const [p, q] = (req.url || "/").split("?");
  const ok = (body, code) => { res.writeHead(code || 200, { "Content-Type": "text/plain; charset=utf-8" }); res.end(body); };
  if (p === "/pgn") {
    const f = pgnFile();
    return f === null ? ok("not found", 404) : ok(f);
  }
  if (p === "/_advance") { if (played < SCRIPT.length) played++; return ok("played=" + played); }
  if (p === "/_back") { if (played > 0) played--; return ok("played=" + played); }
  if (p === "/_reset") { played = 0; return ok("reset"); }
  if (p === "/_mode") { mode = new URLSearchParams(q).get("m") || "off"; return ok("mode=" + mode); }
  if (p === "/_state") return ok(JSON.stringify({ played, mode, board: replay(played) }));
  ok("fake livechess", 200);
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => sockets.delete(socket));
  socket.on("data", (buf) => {
    // decode one masked client frame (fin text frames only; enough for eboards calls)
    try {
      if (buf.length < 6) return;
      const len7 = buf[1] & 0x7f;
      let off = 2, len = len7;
      if (len7 === 126) { len = buf.readUInt16BE(2); off = 4; }
      else if (len7 === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const mask = buf.slice(off, off + 4); off += 4;
      const data = Buffer.alloc(len);
      for (let i = 0; i < len; i++) data[i] = buf[off + i] ^ mask[i % 4];
      const msg = JSON.parse(data.toString("utf8"));
      if (msg.call === "eboards") send(socket, boardMsg());
    } catch (e) { /* ignore malformed */ }
  });
});

function send(socket, text) {
  const payload = Buffer.from(text, "utf8");
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  try { socket.write(Buffer.concat([header, payload])); } catch (e) { }
}

server.listen(1982, "127.0.0.1", () => console.log("fake livechess on 127.0.0.1:1982"));
