/* Headless test for livechess.js clock ticking + flagfall, driven directly
   (no browser, no timer throttling). Loads the REAL clock.js + livechess.js in
   a vm with stubbed WebSocket / moves / timers, and feeds crafted board
   messages. Run after any change to the clock gate or flag logic:

     node tools/clock-selftest.js .

   Covers the tick-side resolution (the venue black-clock freeze). The rule
   under test: the POSITION decides WHICH clock runs; `run` decides only
   WHETHER one runs, and names a side purely as a last resort.
     1. the board's own clock CHANGES come first. On a move-end feed the side
        that changed has just pressed, so the OTHER side runs; on a live-
        ticking feed the side that changed IS the one running. Which shape the
        feed has is learned from the feed, slowly and reversibly.
     2. then game.toMove, but only while the move engine is certain of it.
     3. then run naming a side — and a name that contradicts a press is thrown
        away for the rest of the connection, so one stray 2 can never pin the
        tick to white for a whole game.
     4. then game.toMove as a bare guess (an adoption's inherited turn).
   Plus: the run-flag trust/inference gate, the pre-game hold, and
   feed-authoritative flagfall (fires from a feed zero, never the local
   countdown; once per side; re-arms for a new game).

   Sept 2026 meet additions:
     9. LiveChess reporting the board INACTIVE (lost) — a stand-in placement
        and no clock. Must NOT reach the move engine, must freeze the clocks,
        and must hand the board back (gap + clock re-read) when it returns.
    10. clock: null on a live board → nothing ticks.
    11. A socket stuck CONNECTING is abandoned after its deadline.
    12. Time the PAGE was asleep is never counted as feed silence. */
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
let turnCertain = false;                              // move engine sure of the side to move
let applied = 0, gaps = 0;                            // calls into the move engine
const movesStub = { applyPlacement() { applied++; }, syncClock() {}, noteFeedGap() { gaps++; }, reset() {},
  START_PLACEMENT: START,
  gameStatus() { return { tracking: true, over, turn_certain: turnCertain }; } };

let sock = null;
// readyState defaults to OPEN so the existing scenarios (which drive onopen by
// hand) keep their meaning; the CONNECTING scenario sets it to 0 itself.
class FakeWS { constructor() { this.sent = []; this.readyState = 1; this.closed = false; sock = this; } send(x) { this.sent.push(x); } close() { this.closed = true; if (this.onclose) this.onclose(); } }

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
game.started = true; game.toMove = "w"; turnCertain = false;
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

// === 3. run NAMES the side (0|1|2 firmware) — the last resort still works ==
// Nothing else has anything to say here: a fresh connection has seen no press
// and the turn is an adoption guess, so naming is all that is left.
reconnect(); game.started = true; game.toMove = "w"; over = false; turnCertain = false;
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
reconnect(); game.started = true; game.toMove = "w"; over = false; turnCertain = true;
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

// === 3c. one stray 2 must not poison every later 1 ========================
// The previous fix read a single 2 as proof the board names sides, so a board
// that sends a 2 for any other reason had every later 1 read as "white" —
// black frozen all over again. The board's own presses now come first, and a
// name that contradicts one is dropped for the rest of the connection.
reconnect(); game.started = true; game.toMove = "w"; over = false; turnCertain = true;
feed(3000, 3000, 1);                                 // resync-adopt
feed(2990, 3000, 2);                                 // white pressed; run happens to say 2
ok("run agrees with the press → BLACK ticks", game.clockRunSide === "b");
feed(2990, 2980, 2);                                 // black pressed; run STILL says 2
ok("run contradicts the press → the press wins, WHITE ticks", game.clockRunSide === "w");
feed(2970, 2980, 1);                                 // white pressed; a poisoned 1 would say "white"
ok("after the contradiction a bare 1 no longer names white → BLACK ticks", game.clockRunSide === "b");

// === 3d. a feed that counts the running clock down between moves ==========
// Some builds report the live value every poll instead of only at each press.
// Then the side whose value is CHANGING is the one running, not the opposite.
// The model flips only after three drops in a row on one clock with no move
// between them — one-off changes must never flip it.
reconnect(); game.started = true; over = false; turnCertain = false; game.toMove = "b";
feed(3000, 3000, 1);                                 // resync-adopt
feed(2999, 3000, 1);                                 // one drop on white: still read as a press
ok("a single drop is still read as a press → BLACK ticks", game.clockRunSide === "b");
feed(2998, 3000, 1);
feed(2997, 3000, 1);                                 // three drops, no move between → live-ticking feed
ok("live-ticking feed learned → the clock counting down runs (WHITE)", game.clockRunSide === "w");
feed(2997, 2999, 1);                                 // black's clock is the one moving now
ok("live-ticking feed → black counting down, BLACK ticks", game.clockRunSide === "b");

// === 3e. the tracked turn beats naming; a guessed turn does not ===========
reconnect(); game.started = true; over = false; turnCertain = true; game.toMove = "w";
feed(2500, 2500, 2);                                 // no press seen yet; run names black
ok("no press yet, turn certain → the tracked turn wins over run naming", game.clockRunSide === "w");
turnCertain = false;                                 // the turn is now only an inherited guess
feed(2500, 2500, 2);
ok("no press, turn only a guess → run naming takes over (BLACK)", game.clockRunSide === "b");

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

// === 9. LiveChess has LOST the board: INACTIVE stand-in must not be read ===
reconnect(); game.started = true; game.toMove = "w"; over = false;
feed(3000, 3000, true);                              // resync-adopt on the fresh socket
feed(2990, 3000, true);                              // white pressed → black ticking
ok("(setup) black ticking, board online", game.clockRunSide === "b" && game.boardOnline === true);
const appliedBefore = applied, gapsBefore = gaps;
const wBefore = game.white.sec, bBefore = game.black.sec;
// what LiveChess 2.2 actually sends once the e-Board is gone (venue capture):
function feedOffline() {
  sock.onmessage({ data: JSON.stringify({ response: "call", id: 1, param: [{
    serialnr: "3000150100", source: null, state: "INACTIVE", battery: null, comment: null,
    board: START, flipped: false, clock: null }] }) });
}
feedOffline(); feedOffline(); feedOffline();
ok("INACTIVE stand-in never reaches the move engine", applied === appliedBefore);
ok("board flagged offline", game.boardOnline === false && LiveChess.diag.board && LiveChess.diag.board.online === false && LiveChess.diag.board.state === "INACTIVE");
ok("clocks FROZEN while the board is gone (nothing ticks)", game.clockRunSide === null);
ok("clock values held, not zeroed", game.white.sec === wBefore && game.black.sec === bBefore);
ok("counted once, not per poll", LiveChess.diag.boardOfflines === 1 && LiveChess.diag.boardOfflineSince != null);
ok("LiveChess answering INACTIVE is not 'silence' (no recycle)", LiveChess.diag.silentRecycles === 0);
// the board comes back mid-game, further on, with the real clocks
feed(2500, 2600, true, "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR");
ok("back ACTIVE → move engine told a gap happened (board picked up at once)", gaps === gapsBefore + 1 && applied === appliedBefore + 1);
ok("back ACTIVE → clocks re-read verbatim from the feed", game.white.sec === 2500 && game.black.sec === 2600 && game.boardOnline === true);
ok("offline-since cleared", LiveChess.diag.boardOfflineSince === null);

// === 10. a live board with no clock data → nothing ticks =================
feed(2490, 2600, true);                              // white pressed → black ticks
ok("(setup) black ticking", game.clockRunSide === "b");
sock.onmessage({ data: JSON.stringify({ response: "call", id: 1, param: [{
  serialnr: "3000150100", state: "ACTIVE", board: MID, clock: null }] }) });
ok("clock: null on a live board → clock stopped, values held", game.clockRunSide === null && game.white.sec === 2490);

// === 11. a socket stuck CONNECTING is abandoned after its deadline ========
// Drive a fresh connect() (serial change), leave the socket in CONNECTING,
// and run the silence watchdog past CONNECT_TIMEOUT_MS.
sock.onclose();                                       // drop the live one
LiveChess.apply({ host: "127.0.0.1", port: 1982, serialnr: "Y", poll_ms: 800, demo_mode: false });
const stuck = sock; stuck.readyState = 0;             // never opens
const monitor = intervals[intervals.length - 1];      // startMonitor() registered last
ok("(setup) socket CONNECTING, not connected", game.lcConnected === false && stuck.readyState === 0);
NOW += 1000; monitor();
ok("under the deadline: left alone", !stuck.closed && LiveChess.diag.connectTimeouts === 0);
for (let k = 0; k < 7; k++) { NOW += 1000; monitor(); }   // the watchdog runs once a second
ok("past the deadline: abandoned and a reconnect scheduled", stuck.closed && LiveChess.diag.connectTimeouts === 1);
LiveChess.apply({ host: "127.0.0.1", port: 1982, serialnr: "3000150100", poll_ms: 800, demo_mode: false });
sock.onopen();

// === 12. the page's own sleep is never counted as feed silence ===========
game.started = true; over = false;
feed(3000, 3000, true);
const mon2 = intervals[intervals.length - 1];
NOW += 1000; mon2();
const recyclesBefore = LiveChess.diag.silentRecycles;
NOW += 60000; mon2();                                 // a hidden tab woke after a minute
ok("60 s page sleep → no recycle, counted as a page sleep", LiveChess.diag.silentRecycles === recyclesBefore && LiveChess.diag.pageSleeps >= 1 && game.lcConnected === true);
NOW += 1000; mon2(); NOW += 1000; mon2(); NOW += 1000; mon2(); NOW += 1000; mon2(); NOW += 1000; mon2(); NOW += 1000; mon2();
ok("...but genuine silence after it still recycles", LiveChess.diag.silentRecycles === recyclesBefore + 1);

console.log("\n" + (failed ? "FAILURES: " + failed : "all clock scenarios passing") + "  (" + passed + " passed)");
process.exit(failed ? 1 : 0);
