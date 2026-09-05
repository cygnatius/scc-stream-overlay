/* Headless test for pgn.js parsing, guarded against the failure it exists for:
   a parse that never returns. The movetext scanner had one character it could
   not step over — a stray "}" inside a variation — and looped for ever on the
   display's only thread. A hang here is a FAIL, not a stall: each parse runs
   in a child process with a deadline.

     node tools/pgn-selftest.js .
*/
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { spawnSync } = require("child_process");

const ROOT = process.argv[2] || ".";
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const CASES = [
  { name: "plain game with %clk", pgn: '[Event "x"]\n[White "a"]\n[Black "b"]\n[Result "*"]\n\n1. e4 {[%clk 1:29:50]} e5 {[%clk 1:29:53]} 2. Nf3 *\n', sans: "e4 e5 Nf3" },
  { name: "stray } inside a variation (used to spin for ever)", pgn: '[Event "x"]\n\n1. e4 e5 ( 1... c5 } 2. Nf3 ) 2. Nf3 Nc6 *\n', sans: "e4 e5 Nf3 Nc6" },
  { name: "stray } at top level is skipped, game kept", pgn: '[Event "x"]\n\n1. e4 } e5 2. Nf3 *\n', sans: "e4 e5 Nf3" },
  { name: "unterminated comment ends the game cleanly", pgn: '[Event "x"]\n\n1. e4 e5 { never closed 2. Nf3\n', sans: "e4 e5" },
  { name: "a } left over after a comment closes early", pgn: '[Event "x"]\n\n1. e4 { a { b } e5 } 2. Nf3 *\n', sans: "e4 e5 Nf3" },
];

if (process.argv[3] === "--inner") {
  // Load the real pgn.js against a stubbed page, parse ONE case, and report the
  // SAN list it matched. Seeding the observed move list with the expected SANs
  // makes reconcile() agree, which is the only public road to the parsed moves.
  const c = CASES[Number(process.argv[4])];
  const ctx = { console, setTimeout: () => 0, clearTimeout() {},
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    Vue: { reactive: (o) => o }, window: {}, performance: { now: () => 0 } };
  ctx.window.SCC = {}; ctx.SCC = ctx.window.SCC;
  ctx.fetch = async () => ({ json: async () => ({ ok: true, pgn: c.pgn, source: "test", fetched_at: 1, stale: false }) });
  vm.createContext(ctx);
  vm.runInContext(read("vendor/chess-0.10.3.min.js"), ctx);
  vm.runInContext(read("public/js/pgn.js"), ctx);
  const game = { moves: c.sans.split(" "), demo: false };
  const cfg = { data: { board: { pgn: { enabled: true, poll_ms: 6000 } } } };
  ctx.SCC.pgn.init(game, cfg);                       // one tick → fetch → parseFile → reconcile
  setImmediate(() => setImmediate(() => {
    const st = ctx.SCC.pgn.state;
    const sans = ctx.SCC.pgn.matchedSans();
    process.stdout.write(JSON.stringify({ parsed: st.parsedGames, status: st.status, sans: sans ? sans.join(" ") : null }));
    process.exit(0);
  }));
} else {
  let failed = 0;
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const r = spawnSync(process.execPath, [__filename, ROOT, "--inner", String(i)], { encoding: "utf8", timeout: 8000 });
    const hung = r.error && r.error.code === "ETIMEDOUT";
    let out = null; try { out = JSON.parse(r.stdout); } catch (e) { }
    const pass = !hung && out && out.parsed === 1 && out.sans === c.sans;
    console.log((pass ? "  PASS  " : "  FAIL  ") + c.name
      + (hung ? "  — HUNG (parser never returned)" : out ? "  → [" + out.sans + "] " + out.status : "  no output: " + (r.stderr || "").split("\n")[0]));
    if (!pass) failed++;
  }
  console.log("\n" + (failed ? "FAILURES: " + failed : "all pgn scenarios passing"));
  process.exit(failed ? 1 : 0);
}
