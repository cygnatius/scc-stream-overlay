/* Headless test for the LEGACY single-file overlay's clock, driven directly
   (no browser, no timer throttling). Loads the real <script> block out of
   scc-stream-overlay.html into a vm with stubbed DOM / WebSocket / timers and
   feeds it crafted eboards messages.

     node tools/legacy-clock-selftest.js .

   Why this exists. Three black-clock fixes went into the SERVED overlay
   (public/js/*) while the venue kept reporting a frozen top clock — the shape
   of fixing a file that is not the one being loaded. The legacy single file is
   reachable from OBS as a local file and still carried the ORIGINAL defect:

       CLOCK_RUN_SIDE = b.clock.run ? STATE.toMove : null

   STATE.toMove is a GUESS after any mid-game adoption (a dropout, an OBS
   reload, a resync), and a wrong guess pins the tick to one side, so the
   thinking player's clock stands still for the rest of the game. The scenarios
   below pin the replacement: the running side comes from the board's OWN clock
   changes, and toMove is only the last resort.

   Covers: the press-derived side (incl. beating a WRONG toMove), a live-ticking
   feed, the run gate and the pre-game hold, the wall-anchored countdown (a
   throttled fire lands on the true value, never drifts), and the resets. */
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
  lastChanged:  () => LAST_CHANGED_SIDE,
  liveTick:     () => LIVE_TICK,
  sawRun:       () => SAW_RUN_TRUE,
  runLive:      () => RUN_IS_LIVE,
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
  sock.onmessage({ data: JSON.stringify({ response: "call", id: 1, param: [{
    serialnr: "3000150100", state: "ACTIVE", board: placement || MID,
    clock: { white: hms(white), black: hms(black), run } }] }) });
}

L.CONFIG().livechess.host = "127.0.0.1:1982";
L.CONFIG().livechess.serialnr = null;
L.connect();
sock.onopen();

console.log("\nLEGACY overlay — clock scenarios\n");

/* Settle the board first. The FIRST placement of a connection is adopted, and
   an adoption starts a clean move list — so anything a scenario wants in
   STATE.moves has to be put there after that has happened, not before. This
   message also carries both clock values as "changed" (we had none), which is
   why it can say nothing about a side. */
feed(3000, 3000, true);
L.STATE().moves = ["e4"];                       // game under way
L.STATE().toMove = "w";

/* === 1. no clock change yet → nothing to read a side from ================= */
/* An idle repeat: same placement, same values. It is also where a genuine run
   flag proves itself — still asserted between presses, where a press-instant
   artifact would already have dropped back to 0. */
feed(3000, 3000, true);
ok("no clock change yet → no side info, falls back to toMove",
   L.runSide() === "w" && L.lastChanged() === null);
ok("run asserted on an idle poll → proven a live flag", L.sawRun() === true);

/* === 2. THE REGRESSION: a press beats a WRONG toMove ====================== */
/* White presses — white's value drops, black's holds — while toMove is still
   the wrong "w" from a mid-game adoption. The old code ran white here and the
   venue watched black's clock stand still. */
feed(2900, 3000, true);
ok("white pressed + WRONG toMove='w' → BLACK runs (the freeze fix)",
   L.runSide() === "b" && L.STATE().toMove === "w");

feed(2900, 2880, true);
ok("black pressed → white runs", L.runSide() === "w");

/* === 3. the run gate ====================================================== */
feed(2800, 2880, false);
ok("run=false → nothing ticks", L.runSide() === null);
feed(2700, 2880, true);
ok("run back to true → resumes", L.runSide() !== null);

/* === 4. a live-ticking feed: the side counting down IS the runner ========= */
/* Some firmware counts the running clock down between moves. Read as presses
   that would name the wrong side on every message. Two further drops on the
   same clock with no move in between prove the feed ticks live. */
L.newGame();
L.STATE().moves = ["e4"];
L.STATE().toMove = "b";
feed(3000, 3000, true);                         // re-anchor after the reset
feed(3000, 2990, true);
feed(3000, 2989, true);
feed(3000, 2988, true);
ok("same clock dropping with no move between → live-ticking feed detected", L.liveTick() === true);
ok("...and the side counting down is the one running", L.runSide() === "b");

/* === 5. pre-game hold on hardware that never asserts run ================== */
L.newGame();                                    // clears moves → not started
feed(3000, 3000, undefined);
ok("never-asserts-run + no moves → pre-game hold, nothing ticks", L.runSide() === null);
L.STATE().moves = ["e4"];
feed(3000, 2990, undefined);
ok("...and once a move has landed it infers from game state", L.runSide() !== null);

/* === 5b. run asserted only AT THE PRESS — the venue freeze ================ */
/* The board flicks run up on the press message and reports 0 on the polls in
   between. Obeyed literally that says "both clocks stopped" for the whole of
   every think — the thinking player's clock stands still all game. No amount of
   WHICH-side work can reach this: the gate has already decided nothing runs.
   A run flag never seen up on an idle poll has not earned the right to stop
   anything. */
L.newGame();
feed(4000, 4000, 0);                            // settle the board (this adoption wipes the list)
L.STATE().moves = ["e4"];                       // ...so put the game under way after it, not before
L.STATE().toMove = "w";                         // the wrong guess a mid-game adoption leaves
ok("(setup) press-artifact board proves nothing", L.runLive() === false);
feed(3990, 4000, 1);                            // WHITE PRESSES: value moves, run flicks up
ok("press-artifact run: the press → BLACK runs", L.runSide() === "b");
feed(3990, 4000, 0);                            // black thinks; run back down, values hold
ok("press-artifact run: black still thinking → BLACK STILL RUNS", L.runSide() === "b");
feed(3990, 4000, 0);
ok("...and it does not stop on the next poll either", L.runSide() === "b");
feed(3990, 3980, 1);                            // black presses back
ok("press-artifact run: black pressed → white runs", L.runSide() === "w");

/* === 5c. an ABSENT run key is silence, not "stopped" ====================== */
/* `!!undefined` is false, so a feed that merely omits the key on the odd poll
   used to freeze the display on exactly those polls. */
L.newGame();
feed(5000, 5000, true);                         // settle
feed(5000, 5000, true);                         // idle repeat → the flag proves itself live
ok("(setup) run proven live on this board", L.runLive() === true);
L.STATE().moves = ["e4"];
L.STATE().toMove = "w";
feed(5000, 5000, undefined);                    // no `run` key at all
ok("run key absent → the feed said nothing, the clock keeps running", L.runSide() === "w");

/* === 6. the countdown is WALL-ANCHORED, not decrement-per-fire ============ */
L.newGame();
L.STATE().moves = ["e4"];
L.STATE().toMove = "b";
feed(3000, 3000, true);
feed(2900, 3000, true);                         // white pressed → black runs
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

/* === 7. resets ============================================================ */
L.newGame();
ok("new game clears the press signals", L.lastChanged() === null && L.liveTick() === false);
feed(3000, 3000, true);
feed(2900, 3000, true);
ok("(setup) a press is tracked again", L.lastChanged() === "w");
sock.onclose();
ok("a disconnect stops the clock and drops the signals",
   L.runSide() === null && L.lastChanged() === null);

console.log("");
if (failed) { console.log(`${failed} FAILED, ${passed} passed`); process.exit(1); }
console.log(`all legacy clock scenarios passing  (${passed} passed)`);
