/* Headless test for livechess.js clock ticking + flagfall, driven directly
   (no browser, no timer throttling). Loads the REAL clock.js + livechess.js in
   a vm with stubbed WebSocket / moves / timers, and feeds crafted board
   messages. Run after any change to the clock or flag logic:

     node tools/clock-selftest.js .

   THE RULE under test: the clock of the side to move counts down while the
   game is under way. Nothing in the LiveChess feed decides which clock ticks
   or whether one does — not `clock.run` as a boolean, not `run` as a side
   name, not which value changed last. Five fixes read those signals and the
   black clock kept freezing at the venue, so this suite pins the opposite:
     1. before the first move nothing ticks; after it, the side to move ticks.
     2. `run` — 0, 1, 2, true, false, absent — changes NOTHING about the tick.
     3. a feed value change re-syncs that clock but does not pick the side.
     4. game over → nothing ticks.
   Plus feed-authoritative flagfall (fires from a feed zero, never the local
   countdown; once per side; re-arms for a new game), the wall-anchored
   countdown, and the connection scenarios from the Sept 2026 meet:
     9. LiveChess reporting the board INACTIVE (lost) — a stand-in placement
        and no clock. Must NOT reach the move engine, must freeze the clocks,
        and must hand the board back (gap + clock re-read) when it returns.
    10. clock: null on a live board → nothing ticks.
    11. A socket stuck CONNECTING is abandoned after its deadline.
    12. Time the PAGE was asleep is never counted as feed silence.
    13. An INACTIVE board that HAS a source is a real board. */
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
let applied = 0, gaps = 0;                            // calls into the move engine
const movesStub = { applyPlacement() { applied++; }, syncClock() {}, noteFeedGap() { gaps++; }, reset() {},
  START_PLACEMENT: START,
  gameStatus() { return { tracking: true, over, turn_certain: true }; } };

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
  const clock = { white: hms(white), black: hms(black) };
  if (run !== undefined) clock.run = run;             // undefined = the key is ABSENT
  sock.onmessage({ data: JSON.stringify({ response: "call", id: 1, param: [{
    serialnr: "3000150100", state: "ACTIVE", board: placement || MID, clock }] }) });
}
function reconnect() { sock.onclose();
  LiveChess.apply({ host: "127.0.0.1", port: 1982, serialnr: "X", poll_ms: 800, demo_mode: false });
  LiveChess.apply({ host: "127.0.0.1", port: 1982, serialnr: "3000150100", poll_ms: 800, demo_mode: false });
  sock.onopen(); }

// === 1. the side to move ticks once the game is under way =================
game.started = false; game.toMove = "w"; over = false;
feed(3000, 3000, true);
ok("before the first move → nothing ticks (even with run=true)", game.clockRunSide === null);
game.started = true; game.toMove = "b";              // 1.e4 landed, black to move
feed(3000, 3000, true);
ok("game under way, black to move → BLACK ticks", game.clockRunSide === "b");
game.toMove = "w";                                   // 1...e5 landed
feed(3000, 3000, true);
ok("white to move → WHITE ticks", game.clockRunSide === "w");

// === 2. `run` changes NOTHING — every shape the venue firmware has sent ====
// The venue's frozen top clock, in each of its guises: run=0 between presses,
// run=1 pinned all game, a stray 2, the key omitted. The side to move ticks
// through all of it. This is the regression gate for the whole rewrite.
reconnect(); game.started = true; over = false; game.toMove = "b";
feed(3000, 3000, 0);                                 // first message: resync-adopt
ok("black to move, run=0 → BLACK TICKS (the freeze)", game.clockRunSide === "b");
NOW += 800; feed(3000, 3000, 0);
ok("...and on the next idle poll with run=0", game.clockRunSide === "b");
feed(3000, 3000, false);
ok("run=false → still BLACK", game.clockRunSide === "b");
feed(3000, 3000, 1);
ok("run=1 (would once have named WHITE) → still BLACK", game.clockRunSide === "b");
feed(3000, 3000, 2);
ok("run=2 → still BLACK", game.clockRunSide === "b");
feed(3000, 3000, "white");
ok("run='white' → still BLACK", game.clockRunSide === "b");
feed(3000, 3000);                                    // no `run` key at all
ok("run key absent → still BLACK", game.clockRunSide === "b");
game.toMove = "w";
feed(3000, 3000, 2);
ok("white to move, run=2 (would once have named BLACK) → WHITE ticks", game.clockRunSide === "w");
feed(3000, 3000, 0);
ok("white to move, run=0 → WHITE ticks", game.clockRunSide === "w");

// === 3. feed value changes re-sync the clock, never pick the side =========
reconnect(); game.started = true; over = false; game.toMove = "b";
feed(3000, 3000, true);                              // resync-adopt
feed(2990, 3000, true);                              // white's value drops (white pressed)
ok("white's value changed → white re-synced to 2990", game.white.sec === 2990);
ok("...and the side to move (black) still ticks", game.clockRunSide === "b");
game.toMove = "w";
feed(2990, 2980, true);                              // black's value drops
ok("black's value changed → black re-synced", game.black.sec === 2980);
ok("...and the side to move (white) ticks", game.clockRunSide === "w");
feed(2990, 2979, true); feed(2990, 2978, true); feed(2990, 2977, true);   // a live-ticking feed
ok("a clock counting down between moves does not move the tick off the side to move", game.clockRunSide === "w");
feed(2900, 2900, true);                              // both change (operator adjust)
ok("both values changed → adopted, side unchanged", game.white.sec === 2900 && game.black.sec === 2900 && game.clockRunSide === "w");

// === 4. game over / new game =============================================
over = true;
feed(2900, 2900, true);
ok("game over → nothing ticks", game.clockRunSide === null);
over = false;
game.started = false; game.toMove = "w";             // pieces reset: moves.js clears started
feed(5400, 5400, true, START);
ok("new game, no move yet → nothing ticks", game.clockRunSide === null);
game.started = true; game.toMove = "b";
feed(5400, 5400, true);
ok("first move of the new game → black ticks", game.clockRunSide === "b");

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
reconnect(); game.started = true; game.toMove = "b"; over = false;
feed(3000, 3000, true);                              // resync-adopt on the fresh socket
feed(2990, 3000, true);
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
ok("back ACTIVE → the side to move ticks again", game.clockRunSide === "b");
ok("offline-since cleared", LiveChess.diag.boardOfflineSince === null);

// === 10. a live board with no clock data → nothing ticks =================
feed(2490, 2600, true);
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

// === 13. an INACTIVE board that HAS a source is a REAL board ==============
// The offline test must never be one word wide. If a LiveChess build labels a
// connected, playing board INACTIVE (no session open in its UI), gating on the
// state alone would discard the whole feed and the overlay would show nothing
// for an entire meet. The venue stand-in is sourceless; a real board is not.
reconnect(); game.started = true; over = false; game.toMove = "w";
feed(3000, 3000, true);                              // a normal ACTIVE message first
const appliedA = applied;
sock.onmessage({ data: JSON.stringify({ response: "call", id: 1, param: [{
  serialnr: "3000150100", source: "COM4", state: "INACTIVE", battery: "80",
  board: MID, clock: { white: hms(2900), black: hms(2900), run: true } }] }) });
ok("INACTIVE WITH a source is believed — placement reaches the move engine", applied === appliedA + 1);
ok("...and the board is not flagged offline", game.boardOnline === true);
ok("...and its clock values are taken", game.white.sec === 2900 && game.black.sec === 2900);
sock.onmessage({ data: JSON.stringify({ response: "call", id: 1, param: [{
  serialnr: "3000150100", source: null, state: "INACTIVE", battery: null,
  board: START, flipped: false, clock: null }] }) });
ok("a SOURCELESS INACTIVE is the stand-in → offline, nothing applied", game.boardOnline === false && applied === appliedA + 1);

console.log("\n" + (failed ? "FAILURES: " + failed : "all clock scenarios passing") + "  (" + passed + " passed)");
process.exit(failed ? 1 : 0);
