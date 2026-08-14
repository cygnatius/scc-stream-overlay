/* Headless test for livechess.js clock ticking + flagfall, driven directly
   (no browser, no timer throttling). Loads the REAL clock.js + livechess.js in
   a vm with stubbed WebSocket / moves / timers, and feeds crafted board
   messages. Run after any change to the clock gate or flag logic:

     node tools/clock-selftest.js .

   Covers the tick-side resolution (the venue black-clock freeze):
     1. run NAMING the side (0|1|2 / "white"/"black" firmware) wins outright —
        even when game.toMove is a wrong adoption guess.
     2. boolean run: the runner is the OPPOSITE of the side whose clock value
        changed at the last move-end — also immune to a wrong toMove.
     3. game.toMove is only the last resort (no change seen yet).
   Plus: the run-flag trust/inference gate, the pre-game hold, and
   feed-authoritative flagfall (fires from a feed zero, never the local
   countdown; once per side; re-arms for a new game). */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = process.argv[2] || ".";
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let passed = 0, failed = 0;
function ok(name, cond) { console.log((cond ? "  PASS  " : "  FAIL  ") + name); cond ? passed++ : failed++; }

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";
const MID = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPPPPPP/RNBQKBNR";   // after 1.e4 — not the start position

const game = { toMove: "w", started: false, moves: [], white: { sec: null }, black: { sec: null },
  clockRunSide: null, flagfall: null, lcConnected: false, rawPlacement: null, demo: false };
let over = false;
const movesStub = { applyPlacement() {}, syncClock() {}, noteFeedGap() {}, reset() {},
  START_PLACEMENT: START,
  gameStatus() { return { tracking: true, over }; } };

let sock = null;
class FakeWS { constructor() { this.sent = []; sock = this; } send(x) { this.sent.push(x); } close() { if (this.onclose) this.onclose(); } }

let NOW = 1_000_000_000;                              // controlled wall clock
const intervals = [];                                 // captured interval callbacks
const ctx = { window: {}, console,
  setInterval: (fn) => (intervals.push(fn), intervals.length),
  clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
  Date: { now: () => NOW }, WebSocket: FakeWS };
ctx.window.SCC = { moves: movesStub, game };
ctx.SCC = ctx.window.SCC;
vm.createContext(ctx);
vm.runInContext(read("public/js/clock.js"), ctx);
vm.runInContext(read("public/js/livechess.js"), ctx);

const LiveChess = ctx.SCC.livechess;
LiveChess.init(game);
LiveChess.apply({ host: "127.0.0.1", port: 1982, serialnr: "3000150100", poll_ms: 800, demo_mode: false });
sock.onopen();

const hms = (s) => Math.floor(s / 3600) + ":" + String(Math.floor((s % 3600) / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
function feed(white, black, run, placement) {
  sock.onmessage({ data: JSON.stringify({ response: "call", id: 1, param: [{
    serialnr: "3000150100", state: "ACTIVE", board: placement || MID,
    clock: { white: hms(white), black: hms(black), run } }] }) });
}
function reconnect() { sock.onclose();
  LiveChess.apply({ host: "127.0.0.1", port: 1982, serialnr: "X", poll_ms: 800, demo_mode: false });
  LiveChess.apply({ host: "127.0.0.1", port: 1982, serialnr: "3000150100", poll_ms: 800, demo_mode: false });
  sock.onopen(); }

// === 1. boolean run, no change info yet → toMove fallback =================
game.started = true; game.toMove = "w";
feed(3000, 3000, true);
ok("boolean run, no change info → toMove fallback", game.clockRunSide === "w");
feed(3000, 3000, false);
ok("boolean run=false → stopped", game.clockRunSide === null);

// === 2. boolean run + last-changed beats a WRONG toMove ====================
// White presses (white's value drops) while toMove is wrongly "w" after an
// adoption guess. The runner must be BLACK — the venue freeze scenario.
game.toMove = "w";                                   // wrong guess persists
feed(2990, 3000, true);                              // white's value changed → white just pressed
ok("white pressed + wrong toMove=w → BLACK ticks (freeze fix)", game.clockRunSide === "b");
feed(2990, 2990, true);                              // now black presses
ok("black pressed → white ticks", game.clockRunSide === "w");

// === 3. run NAMES the side (0|1|2 firmware) — wins over everything =========
reconnect(); game.started = true; game.toMove = "w"; over = false;
feed(3000, 3000, 2);                                 // run=2: black running, toMove wrong
ok("run=2 names black + wrong toMove=w → BLACK ticks", game.clockRunSide === "b");
feed(3000, 3000, 1);
ok("run=1 names white → white ticks", game.clockRunSide === "w");
feed(3000, 3000, 0);
ok("run=0 → stopped", game.clockRunSide === null);

// === 3b. integer run=1 meaning plain "running" — the top-clock freeze =======
// A board that has NEVER sent 2 has not proved it names sides, so a bare 1 is
// "the clock is running", not "white". Read as "white" it pinned the tick to
// white all game: black's clock frozen through every think, white's running
// through them. The last-press inference must take over instead.
reconnect(); game.started = true; game.toMove = "w"; over = false;
feed(3000, 3000, 1);                                 // first message: resync-adopt
feed(2990, 3000, 1);                                 // white pressed → BLACK must run
ok("bare run=1 (never seen 2) + white pressed → BLACK ticks", game.clockRunSide === "b");
feed(2990, 2985, 1);                                 // black pressed → white runs
ok("bare run=1 + black pressed → white ticks", game.clockRunSide === "w");
// ...and a board that DOES name sides still wins outright once it proves it.
feed(2980, 2985, 2);
ok("same connection sends 2 → board proved it names sides, BLACK ticks", game.clockRunSide === "b");
feed(2980, 2975, 1);
ok("after a proven 2, run=1 names WHITE again", game.clockRunSide === "w");

// === 4. both values change at once → side info discarded, toMove fallback ==
reconnect(); game.started = true; game.toMove = "b";
feed(2500, 2500, true);                              // resync-adopt: no change events
feed(2400, 2400, true);                              // BOTH change (operator adjust)
ok("both values changed → toMove fallback", game.clockRunSide === "b");

// === 5. a new game (start placement) clears stale move-end info ============
game.toMove = "w";
feed(2300, 2400, true);                              // white changed → black runs
ok("(setup) white pressed → black ticks", game.clockRunSide === "b");
feed(5400, 5400, false, START);                      // pieces reset: both values change too
game.started = false;
feed(5400, 5400, true, START);                       // clock started for the new game
ok("new game start placement → stale press info cleared, toMove rules", game.clockRunSide === "w");

// === 6. inference: a board that never asserts run ==========================
reconnect();
game.started = false; over = false; game.toMove = "w";
feed(3000, 3000, false);
ok("inference + pre-game → no tick", game.clockRunSide === null);
game.started = true;
feed(2990, 3000, false);                             // white pressed
ok("inference + started + white pressed → black ticks", game.clockRunSide === "b");
over = true;
feed(2990, 2990, false);
ok("inference stops when game over", game.clockRunSide === null);
over = false;

// === 7. flagfall: feed-authoritative, once, re-arms ========================
reconnect(); game.started = true; game.toMove = "w";
game.flagfall = null;
feed(30, 2990, false);
ok("positive feed → no flag", game.flagfall === null);
game.white.sec = 0;
ok("local countdown to 0 does NOT fire flag", game.flagfall === null);
feed(0, 2990, false);
ok("feed clock at 0 → flag fires (white)", game.flagfall && game.flagfall.side === "w" && game.flagfall.seq === 1);
feed(0, 2990, false);
ok("flag fires once (no repeat while zero)", game.flagfall.seq === 1);
feed(300, 2990, false); feed(0, 2990, false);
ok("flag re-arms on a positive feed, fires again (seq 2)", game.flagfall.seq === 2);
feed(2990, 0, false);
ok("black flag fires (seq 3, side b)", game.flagfall.seq === 3 && game.flagfall.side === "b");

// === 8. wall-time anchored countdown: throttled fires lose no time ========
// The venue-visible symptom of the old decrement-per-fire loop: every late
// timer fire silently lost a second and the clock fell behind / froze.
const before = intervals.length;
ctx.SCC.clock.start(game);
const tick = intervals[before];                       // the countdown callback
ok("(setup) countdown loop registered", typeof tick === "function");
game.clockRunSide = "b"; game.black.sec = 100; game.white.sec = 500;
tick();                                               // anchors
NOW += 1000; tick();
ok("1s later → 99", game.black.sec === 99);
NOW += 7000; tick();                                  // one fire after a 7s throttle gap
ok("7s throttled gap → lands on the true value (92)", game.black.sec === 92);
ok("idle side held", game.white.sec === 500);
game.black.sec = 200;                                 // outside write = feed sync
NOW += 250; tick();                                   // re-anchors on the synced value
NOW += 2000; tick();
ok("feed sync re-anchors → 198 two seconds later", game.black.sec === 198);
game.clockRunSide = null; NOW += 5000; tick();
ok("stopped → holds through elapsed time", game.black.sec === 198);
game.clockRunSide = "b"; tick();                      // resume re-anchors
NOW += 1000; tick();
ok("resume counts from the held value", game.black.sec === 197);

console.log("\n" + (failed ? "FAILURES: " + failed : "all clock scenarios passing") + "  (" + passed + " passed)");
process.exit(failed ? 1 : 0);
