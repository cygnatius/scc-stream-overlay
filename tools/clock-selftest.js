/* Headless test for livechess.js clock ticking + flagfall, driven directly
   (no browser, no timer throttling). Loads the REAL clock.js + livechess.js in
   a vm with stubbed WebSocket / moves / timers, and feeds crafted board
   messages. Run after any change to the clock gate or flag logic:

     node tools/clock-selftest.js .

   Covers: the run-flag gate (trusted when the board asserts it), the
   inference fallback for boards that never assert run (the "clock only counts
   down some of the time" fix), the pre-game hold, and feed-authoritative
   flagfall (fires from a feed clock at zero, never from the local countdown;
   once per side; re-arms for a new game). */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = process.argv[2] || ".";
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let passed = 0, failed = 0;
function ok(name, cond) { console.log((cond ? "  PASS  " : "  FAIL  ") + name); cond ? passed++ : failed++; }

const game = { toMove: "w", started: false, moves: [], white: { sec: null }, black: { sec: null },
  clockRunSide: null, flagfall: null, lcConnected: false, rawPlacement: null, demo: false };
let over = false;
const movesStub = { applyPlacement() {}, syncClock() {}, noteFeedGap() {}, reset() {},
  gameStatus() { return { tracking: true, over }; } };

let sock = null;
class FakeWS { constructor() { this.sent = []; sock = this; } send(x) { this.sent.push(x); } close() { if (this.onclose) this.onclose(); } }

const ctx = { window: {}, console, setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {}, Date, WebSocket: FakeWS };
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
function feed(white, black, run) {
  sock.onmessage({ data: JSON.stringify({ response: "call", id: 1, param: [{
    serialnr: "3000150100", state: "ACTIVE", board: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR",
    clock: { white: hms(white), black: hms(black), run } }] }) });
}
function reconnect() { sock.onclose();
  LiveChess.apply({ host: "127.0.0.1", port: 1982, serialnr: "X", poll_ms: 800, demo_mode: false });
  LiveChess.apply({ host: "127.0.0.1", port: 1982, serialnr: "3000150100", poll_ms: 800, demo_mode: false });
  sock.onopen(); }

// 1. run asserted → gate trusts the feed flag
game.started = true; game.toMove = "w";
feed(3000, 3000, true); ok("run asserted → side to move ticks", game.clockRunSide === "w");
feed(3000, 3000, false); ok("run asserted then false → stopped", game.clockRunSide === null);

// 2. inference: a board that never asserts run
reconnect();
game.started = false; over = false; game.toMove = "w";
feed(3000, 3000, false); ok("inference + pre-game → no tick", game.clockRunSide === null);
game.started = true;
feed(2990, 3000, false); ok("inference + started → ticks despite run=false", game.clockRunSide === "w");
game.toMove = "b";
feed(2990, 2995, false); ok("inference follows side to move", game.clockRunSide === "b");
over = true;
feed(2990, 2990, false); ok("inference stops when game over", game.clockRunSide === null);
over = false;

// 3. flagfall: feed-authoritative, once, re-arms
game.flagfall = null; game.toMove = "w"; game.started = true;
feed(30, 2990, false); ok("positive feed → no flag", game.flagfall === null);
game.white.sec = 0; ok("local countdown to 0 does NOT fire flag", game.flagfall === null);
feed(0, 2990, false); ok("feed clock at 0 → flag fires (white)", game.flagfall && game.flagfall.side === "w" && game.flagfall.seq === 1);
feed(0, 2990, false); ok("flag fires once (no repeat while zero)", game.flagfall.seq === 1);
feed(300, 2990, false); feed(0, 2990, false); ok("flag re-arms on a positive feed, fires again (seq 2)", game.flagfall.seq === 2);
feed(2990, 0, false); ok("black flag fires (seq 3, side b)", game.flagfall.seq === 3 && game.flagfall.side === "b");

console.log("\n" + (failed ? "FAILURES: " + failed : "all clock scenarios passing") + "  (" + passed + " passed)");
process.exit(failed ? 1 : 0);
