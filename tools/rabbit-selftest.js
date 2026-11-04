/* Headless test for the RabbitConnect board reader (tools/rabbit-feed.js).

     node tools/rabbit-selftest.js

   The fixtures are REAL pictures of RabbitConnect's board diagram, taken on
   the venue PC during the 3 Oct 2026 meet, with the position written down by
   eye at the time. What is pinned here:

     • both captured positions read back exactly — fixture b has a knight and
       a queen on dark squares, which the templates were never cut from;
     • anything that is not a clean picture of the diagram is REJECTED rather
       than read: a picture shifted by a pixel, one smudged square, a blank
       window, a window too small. The reader may say "I cannot see the board";
       it may never say something the board does not show. */
"use strict";
const fs = require("fs");
const path = require("path");
const { readPlacement, readRows, clockSec, makeClockShaper, TILE, STOP_MS } = require("./rabbit-feed.js");

let passed = 0, failed = 0;
function ok(name, cond) { console.log((cond ? "  PASS  " : "  FAIL  ") + name); cond ? passed++ : failed++; }

const load = (f) => {
  const j = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", f), "utf8"));
  return { w: j.w, h: j.h, placement: j.placement, lum: Buffer.from(j.b64, "base64") };
};
const A = load("rabbit-2026-10-03-a.json");
const B = load("rabbit-2026-10-03-b.json");

console.log("reads the venue captures");
{
  const a = readPlacement(A.lum, A.w, A.h);
  ok("fixture a reads cleanly", a.ok === true);
  ok("fixture a is the position written down at the time", a.placement === A.placement);
  const b = readPlacement(B.lum, B.w, B.h);
  ok("fixture b reads cleanly", b.ok === true);
  ok("fixture b: knight on c3 and queen on d8 (dark squares) read right", b.placement === B.placement);
  ok("the two captures are different positions", a.placement !== b.placement);
}

console.log("a wider window (the real client area) reads the same");
{
  const w = 384, h = 241, wide = Buffer.alloc(w * h, 255);
  for (let y = 0; y < A.h; y++) A.lum.copy(wide, y * w, y * A.w, y * A.w + A.w);
  const r = readPlacement(wide, w, h);
  ok("384x241 frame with the board top-left", r.ok && r.placement === A.placement);
}

console.log("refuses what it cannot read");
{
  // shifted one pixel right / down: no square lines up with its template
  const sx = Buffer.alloc(A.lum.length, 255), sy = Buffer.alloc(A.lum.length, 255);
  for (let y = 0; y < A.h; y++) for (let x = 1; x < A.w; x++) sx[y * A.w + x] = A.lum[y * A.w + x - 1];
  for (let y = 1; y < A.h; y++) A.lum.copy(sy, y * A.w, (y - 1) * A.w, y * A.w);
  ok("shifted 1px right → rejected", readPlacement(sx, A.w, A.h).ok === false);
  ok("shifted 1px down → rejected", readPlacement(sy, A.w, A.h).ok === false);

  // one square smudged (e4: file 4, row 4) — half of it painted black
  const smudge = Buffer.from(A.lum);
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE / 2; x++) smudge[(4 * TILE + y) * A.w + 4 * TILE + x] = 0;
  const s = readPlacement(smudge, A.w, A.h);
  ok("one smudged square → whole frame rejected", s.ok === false);
  ok("…and it names the square", /e4/.test(s.reason || ""));

  // a piece half-drawn (top half of a8's rook only)
  const half = Buffer.from(A.lum);
  for (let y = TILE / 2; y < TILE; y++) for (let x = 0; x < TILE; x++) half[y * A.w + x] = 255;
  ok("a half-drawn piece → rejected, not read as empty or as another piece", readPlacement(half, A.w, A.h).ok === false);

  // a blank white window is not an empty board: the hatching is missing
  ok("blank white window → rejected", readPlacement(Buffer.alloc(224 * 224, 255), 224, 224).ok === false);
  ok("blank black window → rejected", readPlacement(Buffer.alloc(224 * 224, 0), 224, 224).ok === false);
  ok("mid-grey window → rejected", readPlacement(Buffer.alloc(224 * 224, 128), 224, 224).ok === false);
  ok("window too small → rejected", readPlacement(Buffer.alloc(200 * 200, 255), 200, 200).ok === false);
}

console.log("an empty square on a real diagram is still an empty square");
{
  // lift the white king off f1 (light square): paint its square clean
  const lifted = Buffer.from(A.lum);
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) lifted[(7 * TILE + y) * A.w + 5 * TILE + x] = 255;
  const r = readPlacement(lifted, A.w, A.h);
  ok("king lifted from f1 reads as the same position without it", r.ok && r.placement === "r3kb1r/ppp1qppp/2n3n1/4Pb2/2P5/PP3NP1/1B2NPBP/R2Q3R");
}

console.log("the diagram as text (the cross-check)");
{
  // Captured from RabbitConnect's row controls at 15:25 on 3 Oct 2026, while
  // the picture reader — checked by eye — gave the placement below.
  const ROWS = ["*+lT*V*T", "OoO*+oOo", "*+m+w+m+", "+*+nPv+*", "*+p+*+*+", "Pp+*+nP*", "*B*+*PbP", "R*+q+k+r"];
  const r = readRows(ROWS);
  ok("the venue rows read as the position the picture gave", r.ok && r.placement === "2kr1b1r/ppp2ppp/2n1q1n1/3NPb2/2P5/PP3NP1/1B3PBP/R2Q1K1R");
  const bad = (rows) => readRows(rows).ok === false;
  ok("upper case on a light square → refused", bad(["T+lT*V*T"].concat(ROWS.slice(1))));
  ok("lower case on a dark square → refused", bad(["*tlT*V*T"].concat(ROWS.slice(1))));
  ok("empty-dark mark on a light square → refused", bad(["++lT*V*T"].concat(ROWS.slice(1))));
  ok("an unknown character → refused", bad(["*+xT*V*T"].concat(ROWS.slice(1))));
  ok("a short row → refused", bad(["*+lT*V*"].concat(ROWS.slice(1))));
  ok("seven rows → refused", bad(ROWS.slice(1)));
  ok("empty rows (fields not found) → refused", bad(["", "", "", "", "", "", "", ""]));
}

console.log("clocks: RabbitConnect ticks every second, the overlay is told only at move-end — and which clock is ticking");
{
  ok("0:50:29 parses", clockSec("0:50:29") === 3029);
  ok("1:30:00 parses", clockSec("1:30:00") === 5400);
  ok("blank / junk / mm:ss do not parse", clockSec("") === null && clockSec("--:--") === null && clockSec("50:29") === null && clockSec(undefined) === null);

  const c = makeClockShaper();
  let t = 1000000;
  const look = (w, b) => { c.observe("w", w, t); c.observe("b", b, t); };
  ok("nothing seen yet → no clock sent", c.field() === null);
  look(3178, 3029);
  ok("first sight is passed on as it stands", c.field().white === "0:52:58" && c.field().black === "0:50:29");

  // white thinks for 60 s: a look every 400 ms, the value dropping once a second
  for (let i = 1; i <= 150; i++) { t += 400; look(3178 - Math.floor(i * 0.4), 3029); }
  ok("while White's clock runs the overlay keeps the turn's starting value", c.field().white === "0:52:58");
  ok("…and it is known to be the one ticking", c.running() === "w");
  ok("Black's value is untouched", c.field().black === "0:50:29");

  ok("…and the overlay is told so", c.field().ticking === "w");

  // white presses the clock: white stops at 3118, black starts ticking
  const stopAt = 3178 - 60;
  t += 400; look(stopAt, 3029); t += 400; look(stopAt, 3029);
  ok("just after the press nothing has moved yet: White still ticking as far as anyone can tell", c.field().white === "0:52:58" && c.field().ticking === "w");
  t += 400; look(stopAt, 3028);                       // Black's first tick
  ok("Black's first tick IS the press: White's move-end value goes out at once, not " + STOP_MS + " ms later", c.field().white === "0:51:58");
  ok("…and the tick moves to Black", c.field().ticking === "b" && c.running() === "b");
  ok("Black, now ticking, still shows its starting value", c.field().black === "0:50:29");

  // a pause: Black's clock is stopped mid-think and nobody's starts
  for (let i = 1; i <= 5; i++) { t += 400; look(stopAt, 3028 - Math.floor(i * 0.4)); }   // down to 3026
  for (let k = 0; k < 8; k++) { t += 400; look(stopAt, 3026); }                          // 3.2 s, no tick anywhere
  ok("no tick anywhere for " + STOP_MS + " ms → a pause: Black's value goes out where it stopped, nobody ticking", c.field().black === "0:50:26" && c.field().ticking === null);
  t += 400; look(stopAt, 3025);
  ok("play resumes → Black ticking again, shown from the paused value", c.field().ticking === "b" && c.field().black === "0:50:26");

  // black moves with a 30 s increment: the value jumps UP
  t += 400; look(stopAt, 3025 + 30);
  ok("an increment is passed on at once", c.field().black === "0:50:55");

  // which clock is running is the LATER tick, even in the instant both look live
  const r = makeClockShaper();
  r.observe("w", 100, t); r.observe("b", 100, t);
  r.observe("w", 99, t + 1000);
  ok("white's clock going down → white running", r.running() === "w");
  r.observe("b", 99, t + 2000);
  ok("black's first tick → black running, white's stop declared", r.running() === "b" && r.field().ticking === "b" && r.field().white === "0:01:39");

  // the arbiter resets both clocks
  t += 400; look(5400, 5400);
  ok("a reset is passed on at once", c.field().white === "1:30:00" && c.field().black === "1:30:00");

  // the reader stalls and the next look is 8 s lower — not an ordinary tick
  t += 8000; look(5392, 5400);
  ok("a jump of several seconds is passed on rather than hidden", c.field().white === "1:29:52");

  // a field goes unreadable
  t += 400; look(null, 5400);
  ok("one unreadable clock → no clock sent", c.field() === null);
  t += 400; look(5391, 5400);
  ok("…and it comes back as it stands", c.field().white === "1:29:51");

  const z = makeClockShaper();
  z.observe("w", 0, t); z.observe("b", 0, t);
  ok("both clocks at 0:00:00 (clock off / not set) → no clock sent, no flagfall", z.field() === null);
  const fl = makeClockShaper();
  fl.observe("w", 2, t); fl.observe("b", 900, t);
  fl.observe("w", 1, t + 1000); fl.observe("w", 0, t + 2000);
  fl.observe("w", 0, t + 2000 + STOP_MS + 100);
  ok("one clock really reaching zero IS sent", fl.field() && fl.field().white === "0:00:00" && fl.field().black === "0:15:00");
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
