/* Headless test for the LEGACY single-file overlay's clock, driven directly
   (no browser, no timer throttling). Loads the real <script> block out of
   scc-stream-overlay.html into a vm with stubbed DOM / WebSocket / timers and
   feeds it crafted eboards messages.

     node tools/legacy-clock-selftest.js .

   Why this exists. The legacy single file is reachable from OBS as a local
   file, so every clock fix has to land here as well as in public/js/*.

   THE RULE under test: the clock of the side to move counts down while the
   game is under way. `clock.run` — in any shape — decides nothing. Five fixes
   read the running side out of the feed (run as a boolean gate, run as a side
   name, which value changed last, live-tick detection) and the black clock
   kept freezing at the venue; this suite pins the opposite.

   Covers: the pre-game hold, the side to move ticking through every `run`
   value the venue has sent, feed value changes re-syncing without picking a
   side, the wall-anchored countdown (a throttled fire lands on the true value,
   never drifts), and the resets. */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = process.argv[2] || ".";
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let passed = 0, failed = 0;
function ok(name, cond) { console.log((cond ? "  PASS  " : "  FAIL  ") + name); cond ? passed++ : failed++; }

/* ---------------------------------------------------------------- the source
   Take the page's own script block, so this test can never drift from the
   file it is guarding. */
/* The file has mixed line endings, so match the tags rather than slicing on a
   literal "\n<script>\n". The INLINE block is the one with no src attribute. */
const html = read("scc-stream-overlay.html");
const m = /^[ \t]*<script>[ \t]*\r?$/m.exec(html);
if (!m) { console.error("could not find the inline <script> block"); process.exit(2); }
const open = m.index + m[0].length;
const close = html.indexOf("</script>", open);
if (close < 0) { console.error("unterminated inline <script> block"); process.exit(2); }
const source = html.slice(open, close);

/* Top-level `let` in a vm script lives in the declarative scope, not on the
   context object, so the probe has to be appended to the source itself. */
const probe = `
globalThis.__legacy = {
  STATE:        () => STATE,
  runSide:      () => CLOCK_RUN_SIDE,
  anchor:       () => CLOCK_ANCHOR,
  CONFIG:       () => CONFIG,
  connect:      () => connectLiveChess(),
  newGame:      () => newGameFromStart(),
};`;

/* ------------------------------------------------------------------- stubs */
function fakeEl() {
  const el = {
    textContent: "", innerHTML: "", value: "", style: { cssText: "" },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    dataset: {}, children: [],
    appendChild(c) { el.children.push(c); return c; },
    removeChild() {}, remove() {}, setAttribute() {}, removeAttribute() {},
    addEventListener() {}, querySelector() { return fakeEl(); },
    querySelectorAll() { return []; }, getBoundingClientRect() { return { width: 0, height: 0 }; },
    insertAdjacentHTML() {}, focus() {}, cloneNode() { return fakeEl(); },
  };
  return el;
}

let NOW = 1_000_000_000;                       // controlled wall clock (ms)
const intervals = [];                          // [{ fn, ms }] — every registered interval
let sock = null;
class FakeWS {
  constructor() { this.sent = []; this.readyState = 1; sock = this; }
  send(x) { this.sent.push(x); }
  close() { if (this.onclose) this.onclose(); }
}

const doc = {
  getElementById: () => fakeEl(),
  createElement: () => fakeEl(),
  querySelector: () => fakeEl(),
  querySelectorAll: () => [],
  addEventListener() {},
  body: fakeEl(),
  documentElement: fakeEl(),
  readyState: "complete",
};

const ctx = {
  console,
  document: doc,
  window: { innerWidth: 1920, innerHeight: 1080, addEventListener() {}, location: { protocol: "http:", hash: "" } },
  location: { protocol: "http:", hash: "" },
  navigator: { userAgent: "selftest" },
  setInterval: (fn, ms) => (intervals.push({ fn, ms }), intervals.length),
  clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
  Date: { now: () => NOW },
  WebSocket: FakeWS,
  fetch: () => Promise.reject(new Error("no network in selftest")),
  Math, JSON, String, Number, Array, Object, Boolean, isNaN, parseInt, parseFloat, Promise, Error,
};
ctx.globalThis = ctx;
ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(read("vendor/chess-0.10.3.min.js"), ctx);   // provides Chess
vm.runInContext(source + probe, ctx);

const L = ctx.__legacy;

/* The countdown interval is the 250 ms one registered next to CLOCK_ANCHOR. */
const clockTimer = intervals.find((i) => i.ms === 250);
function tick(seconds) { NOW += seconds * 1000; clockTimer.fn(); }

/* ---------------------------------------------------------------- the feed */
const MID = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPPPPPP/RNBQKBNR";
const hms = (s) => Math.floor(s / 3600) + ":" + String(Math.floor((s % 3600) / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
function feed(white, black, run, placement) {
  const clock = { white: hms(white), black: hms(black) };
  if (run !== undefined) clock.run = run;      // undefined = the key is ABSENT
  sock.onmessage({ data: JSON.stringify({ response: "call", id: 1, param: [{
    serialnr: "3000150100", state: "ACTIVE", board: placement || MID, clock }] }) });
}

L.CONFIG().livechess.host = "127.0.0.1:1982";
L.CONFIG().livechess.serialnr = null;
L.connect();
sock.onopen();

console.log("\nLEGACY overlay — clock scenarios\n");

/* Settle the board first. The FIRST placement of a connection is adopted, and
   an adoption starts a clean move list — so anything a scenario wants in
   STATE.moves has to be put there after that has happened, not before. */
feed(3000, 3000, true);

/* === 1. pre-game hold, then the side to move ============================== */
ok("no move yet → nothing ticks (even with run=true)", L.runSide() === null);
L.STATE().moves = ["e4"];                       // game under way
L.STATE().toMove = "b";
feed(3000, 3000, true);
ok("black to move → BLACK ticks", L.runSide() === "b");
L.STATE().toMove = "w";
feed(3000, 3000, true);
ok("white to move → WHITE ticks", L.runSide() === "w");

/* === 2. `run` changes NOTHING — the venue freeze in each of its guises ===== */
L.STATE().toMove = "b";
feed(3000, 3000, 0);
ok("black to move, run=0 → BLACK TICKS (the freeze)", L.runSide() === "b");
feed(3000, 3000, 0);
ok("...and on the next idle poll", L.runSide() === "b");
feed(3000, 3000, false);
ok("run=false → still BLACK", L.runSide() === "b");
feed(3000, 3000, 1);
ok("run=1 (would once have named WHITE) → still BLACK", L.runSide() === "b");
feed(3000, 3000, 2);
ok("run=2 → still BLACK", L.runSide() === "b");
feed(3000, 3000);                               // no `run` key at all
ok("run key absent → still BLACK", L.runSide() === "b");
L.STATE().toMove = "w";
feed(3000, 3000, 2);
ok("white to move, run=2 (would once have named BLACK) → WHITE ticks", L.runSide() === "w");

/* === 3. feed value changes re-sync, never pick the side =================== */
L.STATE().toMove = "b";
feed(2900, 3000, true);                         // white's value drops
ok("white's value changed → re-synced to 2900", L.STATE().white.sec === 2900);
ok("...and black (to move) still ticks", L.runSide() === "b");
feed(2900, 2990, true); feed(2900, 2989, true); feed(2900, 2988, true);   // a live-ticking feed
ok("black's clock counting down between moves → re-synced, side unchanged",
   L.STATE().black.sec === 2988 && L.runSide() === "b");
L.STATE().toMove = "w";
feed(2800, 2800, true);                         // both change (operator adjust)
ok("both values changed → adopted, white (to move) ticks",
   L.STATE().white.sec === 2800 && L.STATE().black.sec === 2800 && L.runSide() === "w");

/* === 4. the countdown is WALL-ANCHORED, not decrement-per-fire ============ */
L.newGame();
L.STATE().moves = ["e4"];
L.STATE().toMove = "b";
feed(3000, 3000, true);
ok("(setup) black is the running side", L.runSide() === "b");
tick(0);                                        // take the anchor
tick(1);
ok("1 s later → 2999", L.STATE().black.sec === 2999);
tick(7);                                        // a throttled 7 s gap, ONE fire
ok("7 s throttled gap, one fire → lands on the true value (2992), no drift",
   L.STATE().black.sec === 2992);
const heldWhite = L.STATE().white.sec;
tick(5);
ok("the idle side is untouched", L.STATE().white.sec === heldWhite);

/* === 5. resets ============================================================ */
L.newGame();
ok("new game → nothing ticks until a move lands", L.runSide() === null);
feed(3000, 3000, true);
ok("...still nothing after a feed message with no moves", L.runSide() === null);
L.STATE().moves = ["e4"]; L.STATE().toMove = "b";
feed(3000, 3000, true);
ok("(setup) ticking again", L.runSide() === "b");
sock.onclose();
ok("a disconnect stops the clock", L.runSide() === null);

console.log("");
if (failed) { console.log(`${failed} FAILED, ${passed} passed`); process.exit(1); }
console.log(`all legacy clock scenarios passing  (${passed} passed)`);
