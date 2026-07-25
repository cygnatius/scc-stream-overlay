/* Headless harness: drives the REAL public/js/moves.js against scripted DGT
   placement streams, to reproduce the venue seize and verify the fix.

   Models the feed faithfully: LiveChess re-sends the CURRENT placement on every
   poll, so each scripted position is applied once and then re-applied on idle
   polls with a virtual clock advancing, which is what puts a hold on the clock.

   Usage: node engine-repro.js <repoRoot> */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = process.argv[2];
const POLL_MS = 800;
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

function load() {
  const clock = { t: 1700000000000 };
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Date: new Proxy(Date, { get: (t, p) => (p === "now" ? () => clock.t : t[p]) }),
    document: { createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }) },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read("vendor/chess-0.10.3.min.js"), sandbox);
  vm.runInContext(read("public/js/board.js"), sandbox);
  vm.runInContext(read("public/js/moves.js"), sandbox);

  const game = {
    fen: "8/8/8/8/8/8/8/8 w - - 0 1", rawPlacement: null, lastMove: null, toMove: "w",
    moves: [], currentPly: -1, started: false, demo: false, lcConnected: true,
    clockRunSide: null, white: { sec: 3600 }, black: { sec: 3600 }, timesVersion: 0,
  };
  sandbox.SCC.moves.init(game);
  if (sandbox.SCC.moves.configure) sandbox.SCC.moves.configure({});   // defaults
  return { SCC: sandbox.SCC, game, Chess: sandbox.Chess, clock };
}

const P = (sans) => {                       // SAN list → placement after each
  const { Chess } = load();
  const c = new Chess();
  const out = [c.fen().split(" ")[0]];
  for (const s of sans) { if (!c.move(s)) throw new Error("bad san " + s); out.push(c.fen().split(" ")[0]); }
  return out;
};
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";

// Apply one placement, then idle polls (feed repeats it, clock advances).
function push(env, placement, idlePolls) {
  env.SCC.moves.applyPlacement(placement);
  for (let i = 0; i < (idlePolls || 0); i++) {
    env.clock.t += POLL_MS;
    env.SCC.moves.applyPlacement(placement);
  }
  env.clock.t += POLL_MS;
}

function report(env, board, label) {
  const engine = env.game.fen.split(" ")[0];
  const ok = engine === board;
  const d = env.SCC.moves.diag || {};
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) { console.log(`        board : ${board}`); console.log(`        engine: ${engine}`); }
  console.log(`        moves ${env.game.moves.length} [${env.game.moves.slice(-6).join(" ")}]  state=${d.state} resyncs=${d.resyncs} deep=${d.deepHits} unexplained=${d.unexplained}`);
  return ok;
}

const results = [];
const scenario = (name, fn) => {
  console.log("\n— " + name);
  try { results.push([name, fn()]); } catch (e) { console.log("  ERROR " + e.stack.split("\n")[0]); results.push([name, false]); }
};

/* 1. Baseline: normal game. Must never regress. */
scenario("normal play (sanity)", () => {
  const env = load();
  const all = P(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"]);
  for (const p of all) push(env, p, 1);
  return report(env, all[all.length - 1], "board mirrored after 6 moves")
    && env.game.moves.join(" ") === "e4 e5 Nf3 Nc6 Bb5 a6";
});

/* 2. THE VENUE BUG #1: castling after the overlay joined a game in progress. */
scenario("castling after mid-game join", () => {
  const env = load();
  const all = P(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "O-O"]);
  for (const p of all.slice(2)) push(env, p, 1);
  return report(env, all[all.length - 1], "white castles while overlay joined mid-game");
});

/* 3. THE VENUE BUG #2: a gap of several half-moves (socket stall / throttle). */
scenario("4-ply gap (missed polls)", () => {
  const env = load();
  const all = P(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4"]);
  for (const p of [all[0], all[1], all[2]]) push(env, p, 1);
  push(env, all[6], 6);                                  // jump; watchdog gets its chance
  return report(env, all[6], "board mirrored after a 4-ply jump");
});

/* 4. A settled position we cannot explain (pieces knocked over and replaced
      wrong, operator adjustment). Must resync, keep history, then track on. */
scenario("settled desync → resync, history kept", () => {
  const env = load();
  const open = P(["e4", "e5", "Nf3", "Nc6"]);
  for (const p of open) push(env, p, 1);
  const movesBefore = env.game.moves.length;

  const c = new (load().Chess)();
  ["e4", "e5", "Nf3", "Nc6"].forEach(s => c.move(s));
  c.remove ? null : null;
  const bogus = c.fen().split(" ")[0].replace("R3KB1R", "3RKB1R");   // a1 rook teleported to d1
  push(env, bogus, 8);                                   // > resync_ms of idle polls
  const resynced = env.game.fen.split(" ")[0] === bogus;
  console.log(`  ${resynced ? "PASS" : "FAIL"}  resynced to the physical board`);
  const kept = env.game.moves.length >= movesBefore;
  console.log(`  ${kept ? "PASS" : "FAIL"}  move history preserved (${movesBefore} → ${env.game.moves.length})`);

  // play on from the corrected position
  const c2 = new (load().Chess)(bogus + " w " + "kq" + " - 0 1");
  const after = [];
  ["Bb5", "a6"].forEach(s => { if (!c2.move(s)) throw new Error("setup " + s); after.push(c2.fen().split(" ")[0]); });
  for (const p of after) push(env, p, 1);
  return resynced && kept && report(env, after[after.length - 1], "tracking continues after resync");
});

/* 5. Piece lifted and held while thinking — must HOLD, never resync. */
scenario("piece in hand (must hold, never resync)", () => {
  const env = load();
  push(env, START, 1);
  const c = new (load().Chess)();
  const lifted = START.replace("PPPPPPPP", "PPPP1PPP");            // e2 pawn in hand
  push(env, lifted, 30);                                            // ~25s of thinking
  const held = env.game.fen.split(" ")[0] === START;
  const d = env.SCC.moves.diag;
  console.log(`  ${held ? "PASS" : "FAIL"}  held the last good position (state=${d.state}, resyncs=${d.resyncs})`);
  c.move("e4");
  push(env, c.fen().split(" ")[0], 1);
  return held && d.resyncs === 0 && report(env, c.fen().split(" ")[0], "committed e4 when the piece landed")
    && env.game.moves.join(" ") === "e4";
});

/* 6. Castling in progress: king placed, rook a moment later. The half-castled
      placement is unexplainable — it must NOT be resynced away before the rook
      lands, or the move list gains a bogus king move. */
scenario("castling in progress (king then rook)", () => {
  const env = load();
  const all = P(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"]);
  for (const p of all) push(env, p, 1);
  const pre = all[all.length - 1];
  const halfK = pre.replace("RNBQK2R", "RNBQ1RKR").replace("RNBQ1RKR", "RNBQ2KR");  // king e1→g1, rook still h1
  push(env, halfK, 1);                                   // ~1.6s mid-castle
  const done = P(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "O-O"]).slice(-1)[0];
  push(env, done, 1);
  return report(env, done, "castling committed cleanly")
    && env.game.moves.slice(-1)[0] === "O-O";
});

/* 7. Operator force-resync (the on-air panic button). */
scenario("manual force resync", () => {
  const env = load();
  const open = P(["e4", "e5"]);
  for (const p of open) push(env, p, 1);
  const wrong = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKB1R";  // g1 knight vanished
  env.SCC.moves.applyPlacement(wrong);                   // held immediately (removal-only = hand)
  const okBefore = env.game.fen.split(" ")[0] === open[open.length - 1];
  console.log(`  ${okBefore ? "PASS" : "FAIL"}  removal treated as a hand in flight (not resynced)`);
  const forced = env.SCC.moves.forceResync();
  const now = env.game.fen.split(" ")[0] === wrong;
  console.log(`  ${forced && now ? "PASS" : "FAIL"}  force resync adopted the board, kept ${env.game.moves.length} moves`);
  return okBefore && forced && now && env.game.moves.length === 2;
});

/* 8. Promotion and en passant still reconstruct at depth 1. */
scenario("promotion + en passant", () => {
  const env = load();
  // 3. exd6 is an en-passant capture; 5. cxd8=Q promotes with a capture.
  const sans = ["e4", "Nf6", "e5", "d5", "exd6", "Nc6", "dxc7", "e6", "cxd8=Q"];
  const all = P(sans);
  for (const p of all) push(env, p, 1);
  return report(env, all[all.length - 1], "en-passant capture and promotion tracked")
    && env.game.moves.slice(-1)[0].indexOf("=Q") > 0;
});

console.log("\n================ SUMMARY ================");
let bad = 0;
for (const [n, ok] of results) { if (!ok) bad++; console.log((ok ? "PASS  " : "FAIL  ") + n); }
console.log(bad ? `\n${bad} scenario(s) FAILING` : "\nall scenarios passing");
process.exit(bad ? 1 : 0);
