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

// One shared store across loads, so a "display reload" can find its snapshot.
const STORE = new Map();
const localStorageStub = {
  getItem: (k) => (STORE.has(k) ? STORE.get(k) : null),
  setItem: (k, v) => STORE.set(k, String(v)),
  removeItem: (k) => STORE.delete(k),
};

function load() {
  const clock = { t: 1700000000000 };
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: localStorageStub,
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

/* 9. A DROPOUT. Moves are played while the feed is away, so they are gone —
      the board must be picked up AT ONCE (not after the resync window) and the
      moves recorded before the outage must survive. */
scenario("feed dropout → board picked up immediately", () => {
  const env = load();
  const all = P(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "b5", "Bb3"]);
  for (const p of all.slice(0, 5)) push(env, p, 1);      // 4 moves tracked
  const before = env.game.moves.length;

  env.SCC.moves.noteFeedGap();                            // socket came back
  env.SCC.moves.applyPlacement(all[9]);                   // 5 plies further on
  const immediate = env.game.fen.split(" ")[0] === all[9];
  // never-wipe: the pre-dropout moves must survive UNCHANGED as a prefix. The
  // list may now be LONGER than that — a short gap gets recovered rather than
  // discarded — so this asserts the prefix, not the length.
  const truth = ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "b5", "Bb3"];
  const kept = env.game.moves.length >= before
    && env.game.moves.slice(0, before).join(" ") === truth.slice(0, before).join(" ");
  const d = env.SCC.moves.diag;
  console.log(`  ${immediate ? "PASS" : "FAIL"}  adopted the board on the first message (no wait) — gapAdopts=${d.gapAdopts}`);
  console.log(`  ${kept ? "PASS" : "FAIL"}  ${before} pre-dropout moves kept as a prefix (list now ${env.game.moves.length})`);

  // and tracking continues from there
  const c = new (load().Chess)(all[9] + " b " + "kq" + " - 0 1");
  c.move("Na5");
  push(env, c.fen().split(" ")[0], 1);
  return immediate && kept && report(env, c.fen().split(" ")[0], "tracking continues after the dropout");
});

/* 10. A dropout while a piece is in hand must still HOLD — a gap is no reason
       to adopt a position with a piece missing. */
scenario("dropout with a piece in hand still holds", () => {
  const env = load();
  const all = P(["e4", "e5"]);
  for (const p of all) push(env, p, 1);
  const lifted = all[2].replace("5N2", "8").replace("RNBQKBNR", "RNBQKBNR");   // no knight yet; lift g1
  const handPlacement = all[2].replace("RNBQKBNR", "RNBQKB1R");                // g1 knight in hand
  env.SCC.moves.noteFeedGap();
  push(env, handPlacement, 8);                            // well past resync_ms
  const held = env.game.fen.split(" ")[0] === all[2];
  const d = env.SCC.moves.diag;
  console.log(`  ${held ? "PASS" : "FAIL"}  held (state=${d.state}, gapAdopts=${d.gapAdopts}, resyncs=${d.resyncs})`);
  return held && d.state === "hand" && d.gapAdopts === 0;
});

/* 11. THE VENUE BUG #3: the move list falling progressively behind the board.
       22 plies played, 17 on the stream, and the deficit grew all game. Every
       scenario above asserts only that the BOARD mirrors — which it always did,
       even while the notation was being shredded — so this reached air through a
       green suite. The lag is what is asserted here. */
scenario("move list keeps up with the board (venue lag)", () => {
  const sans = ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "c3", "Nf6", "d4", "exd4",
    "cxd4", "Bb4+", "Bd2", "Bxd2+", "Nbxd2", "d5", "exd5", "Nxd5", "O-O", "O-O"];
  const all = P(sans);
  let worst = 0, ok = true;
  // a poll misses one ply here and there — the everyday case that was accumulating
  for (const skip of [[], [5], [5, 11], [5, 11, 15]]) {
    const env = load();
    for (let i = 0; i < all.length; i++) {
      if (skip.includes(i)) continue;                    // this placement never observed
      push(env, all[i], 1);
    }
    push(env, all[all.length - 1], 6);                   // settle
    const lag = sans.length - env.game.moves.length;
    worst = Math.max(worst, lag);
    const board = env.game.fen.split(" ")[0] === all[all.length - 1];
    const exact = env.game.moves.join(" ") === sans.join(" ");
    if (lag !== 0 || !board || !exact) ok = false;
    console.log(`  ${lag === 0 && board && exact ? "PASS" : "FAIL"}  ${skip.length} missed poll(s): lag=${lag} board=${board ? "ok" : "WRONG"} notation=${exact ? "exact" : "WRONG"}`);
  }
  console.log(`  ${worst === 0 ? "PASS" : "FAIL"}  worst lag across all runs: ${worst} (must be 0)`);
  return ok && worst === 0;
});

/* 12. RECONSTRUCTION FIDELITY. A placement says where the pieces are, never how
       they got there, so a deep search invents move orders that were never
       played. The depth cap exists to stop that — this pins it down, because
       raising the depth "to keep up" is exactly the tempting wrong fix. */
scenario("reconstruction never fabricates moves", () => {
  const games = [
    ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6", "O-O", "Be7", "Re1", "b5", "Bb3", "d6"],
    ["d4", "Nf6", "c4", "e6", "Nc3", "Bb4", "e3", "O-O", "Bd3", "d5", "Nf3", "c5", "O-O", "Nc6"],
    ["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "a6", "Be3", "e5", "Nb3", "Be6"],
  ];
  let bad = 0;
  for (const sans of games) {
    const all = P(sans);
    const env = load();
    for (let i = 0; i < all.length; i += 2) push(env, all[i], 1);   // 2 plies per poll
    push(env, all[all.length - 1], 6);
    const got = env.game.moves.join(" ");
    // every ply the list DOES contain must be a move that was really played,
    // in the order it was really played — a prefix of the truth, never a fiction
    const isPrefix = sans.slice(0, env.game.moves.length).join(" ") === got;
    if (!isPrefix) bad++;
    console.log(`  ${isPrefix ? "PASS" : "FAIL"}  ${sans.length} plies at 2/poll → ${env.game.moves.length} recorded, ${isPrefix ? "all genuine" : "FABRICATED: " + got}`);
  }
  return bad === 0;
});

/* 13. A THROW INSIDE THE SEARCH MUST NOT POISON THE ENGINE. The turn-retry used
       to install a scratch chess.js instance and restore it only on the success
       path, so an exception left the corrupt instance in place and every poll
       after it threw — the move list froze for the rest of the broadcast. */
scenario("a search that throws costs one poll, not the game", () => {
  const env = load();
  const all = P(["e4", "e5", "Nf3", "Nc6"]);
  for (const p of all) push(env, p, 1);
  const before = env.game.moves.length;

  // a placement no legal line explains, fed while the turn is a guess
  env.SCC.moves.applyPlacement("rnbqkbnr/pppp1ppp/8/4p3/3PP3/2N2N2/PPP2PPP/R1BQKB1R");
  push(env, all[all.length - 1], 8);                     // back to a position it knows

  // and ordinary play must still be tracked afterwards
  const c = new (load().Chess)();
  ["e4", "e5", "Nf3", "Nc6", "Bb5"].forEach(s => c.move(s));
  push(env, c.fen().split(" ")[0], 2);
  const alive = env.game.moves.length >= before && env.game.moves.slice(-1)[0] === "Bb5";
  console.log(`  ${alive ? "PASS" : "FAIL"}  engine survived and tracked the next move [${env.game.moves.join(" ")}]`);
  return alive;
});

/* 14. A DISPLAY RELOAD (OBS source refresh). The move list cannot be rebuilt
       from one placement, so it is restored from the snapshot when the board is
       standing in exactly the position we last showed. */
const asyncResults = (async () => {
  console.log("\n— display reload restores the move list");
  STORE.clear();
  const env = load();
  const all = P(["e4", "e5", "Nf3", "Nc6"]);
  for (const p of all) push(env, p, 1);
  env.SCC.moves.applyPlacement(all[4], "3000150100");     // stamp the serial
  await new Promise(r => setTimeout(r, 1000));            // let the debounced save land
  const saved = STORE.size > 0;
  console.log(`  ${saved ? "PASS" : "FAIL"}  snapshot written`);

  const fresh = load();                                   // ← the reload
  fresh.SCC.moves.applyPlacement(all[4], "3000150100");
  const restored = fresh.game.moves.join(" ") === "e4 e5 Nf3 Nc6";
  const mirrors = fresh.game.fen.split(" ")[0] === all[4];
  console.log(`  ${restored ? "PASS" : "FAIL"}  move list restored after reload [${fresh.game.moves.join(" ")}]`);
  console.log(`  ${mirrors ? "PASS" : "FAIL"}  board mirrored after reload`);

  // A DIFFERENT position must NOT restore stale history — board still correct.
  STORE.clear();
  const env2 = load();
  for (const p of all) push(env2, p, 1);
  env2.SCC.moves.applyPlacement(all[4], "3000150100");
  await new Promise(r => setTimeout(r, 1000));
  const other = load();
  const elsewhere = P(["d4", "d5", "c4"])[3];
  other.SCC.moves.applyPlacement(elsewhere, "3000150100");
  const noStale = other.game.moves.length === 0 && other.game.fen.split(" ")[0] === elsewhere;
  console.log(`  ${noStale ? "PASS" : "FAIL"}  a different position adopts fresh (no stale history)`);

  /* 15. BOARD OFFLINE AT BOOT. LiveChess has lost the e-Board and the display
         reloads (or the OBS source is refreshed): no real placement arrives,
         only INACTIVE stand-ins, which livechess.js never passes on. The last
         shown position, moves and clock values must come back from the snapshot
         rather than an empty board, and the board's return is then judged like
         any gap: same position → in step, further on → adopted, history kept. */
  console.log("\n— board offline at boot restores the last known position");
  STORE.clear();
  const env3 = load();
  for (const p of all) push(env3, p, 1);
  env3.SCC.moves.applyPlacement(all[4], "3000150100");
  await new Promise(r => setTimeout(r, 1000));
  const cold = load();                                    // ← reload while the board is gone
  const got = cold.SCC.moves.restoreLastKnown("3000150100");
  const shown = cold.game.fen.split(" ")[0] === all[4] && cold.game.moves.join(" ") === "e4 e5 Nf3 Nc6";
  console.log(`  ${got && shown ? "PASS" : "FAIL"}  offline at boot → last known position and moves shown [${cold.game.moves.join(" ")}]`);
  const clocksBack = cold.game.white.sec === 3600 && cold.game.black.sec === 3600;
  console.log(`  ${clocksBack ? "PASS" : "FAIL"}  clock values restored, held`);
  // the board returns in the SAME position → in step, nothing lost
  cold.SCC.moves.noteFeedGap();
  cold.SCC.moves.applyPlacement(all[4], "3000150100");
  const same = cold.game.moves.length === 4 && cold.SCC.moves.diag.state === "synced";
  console.log(`  ${same ? "PASS" : "FAIL"}  board back in the same position → in step, 4 moves kept`);
  // ...or further on → adopted at once, history kept as a prefix
  const cold2 = load();
  cold2.SCC.moves.restoreLastKnown("3000150100");
  cold2.SCC.moves.noteFeedGap();
  const further = P(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4"])[7];
  cold2.SCC.moves.applyPlacement(further, "3000150100");
  const adopted = cold2.game.fen.split(" ")[0] === further && cold2.game.moves.slice(0, 4).join(" ") === "e4 e5 Nf3 Nc6";
  console.log(`  ${adopted ? "PASS" : "FAIL"}  board back further on → adopted at once, history kept [${cold2.game.moves.join(" ")}]`);
  // a snapshot from ANOTHER board is not shown
  const other2 = load();
  const foreign = other2.SCC.moves.restoreLastKnown("9999");
  console.log(`  ${!foreign ? "PASS" : "FAIL"}  another board's snapshot is not restored`);

  return [["display reload restores the move list", saved && restored && mirrors && noStale],
          ["board offline at boot restores the last known position", got && shown && clocksBack && same && adopted && !foreign]];
})();

asyncResults.then((extra) => {
  results.push(...extra);
  console.log("\n================ SUMMARY ================");
  let bad = 0;
  for (const [n, ok] of results) { if (!ok) bad++; console.log((ok ? "PASS  " : "FAIL  ") + n); }
  console.log(bad ? `\n${bad} scenario(s) FAILING` : "\nall scenarios passing");
  process.exit(bad ? 1 : 0);
});

