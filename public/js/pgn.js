/* =========================================================================
   pgn.js — the AUTHORITATIVE move model (stage 5), behind a probed source.

   The server relays the LiveChess game PGN at /api/pgn (probing candidate
   URLs on the configured host; the display can't fetch LiveChess HTTP
   itself — no CORS headers there). This module polls that endpoint slowly
   (board.pgn.poll_ms, default 6s — nothing to do with the config poll),
   parses every game in the file, validates each by full chess.js replay,
   and matches OUR game by prefix-agreement with the observed move list.

   RECONCILIATION RULES (per the approved approach):
   - The OBSERVED model always drives the displayed move list and board.
   - The PGN model contributes exactly one thing on air: per-move times
     from %clk annotations, per ply, where it agrees with the observed
     model as a prefix or exact match. Any ply the PGN can't time falls
     back to the observed clock delta — same degradation, per ply.
   - Ambiguity (several games agree but disagree with each other) and
     retrieval failure are QUIET: internal flags only, observed drives.
   - Irreconcilable divergence (a source exists, games parsed, none agree)
     shows one small dim dot on the moves panel — no red, no icons.
   - Never discards or rewrites observed history, ever.

   status: off | absent | waiting | agree | ambiguous | diverged | stale
     off       pgn probing disabled in config
     absent    no PGN source found (normal when LiveChess serves none)
     waiting   source found but no observed moves yet to match against
     agree     exactly one parsed game matches the observed prefix
     ambiguous several games match and their clocks disagree — quiet
     diverged  games parsed, none agree — subtle indicator, observed drives
     stale     had agreement, retrieval now failing — last good times held

   Classic script; exposes window.SCC.pgn. Requires vue.global.js,
   chess-0.10.3 (classic global build — do not upgrade), config.js.
   ========================================================================= */
"use strict";
window.SCC = window.SCC || {};

SCC.pgn = (function () {
  let game = null;              // reactive game state (observed model lives here)
  let cfg = null;               // SCC.config.store

  const state = Vue.reactive({
    status: "absent",
    source: "",
    fetchedAt: 0,
    matchedLen: 0,              // plies of the matched game (admin curiosity)
    rev: 0,                     // bumped when reconcile output changes (render trigger)
  });

  let clks = [];                // matched game: %clk seconds per ply (null = none)
  let hadAgreement = false;

  /* ------------------------------------------------------------- parsing */

  function parseClkSeconds(s) {
    const m = /^(\d+):([0-5]?\d):([0-5]?\d(?:\.\d+)?)$/.exec(String(s).trim());
    if (!m) return null;
    return Math.round(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
  }

  // One PGN game chunk → { sans:[], clks:[] } validated by replay, or null.
  function parseGame(chunk) {
    const movetext = chunk.replace(/^\s*\[[^\]]*\]\s*$/gm, " ");
    const sans = [], clkArr = [];
    let i = 0, depth = 0;
    const isResult = (t) => t === "1-0" || t === "0-1" || t === "1/2-1/2" || t === "*";
    const chess = new Chess();
    while (i < movetext.length) {
      const ch = movetext[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === "(") { depth++; i++; continue; }               // variations: skip wholesale
      if (ch === ")") { depth = Math.max(0, depth - 1); i++; continue; }
      if (ch === "{") {
        const end = movetext.indexOf("}", i);
        const body = movetext.slice(i + 1, end === -1 ? movetext.length : end);
        if (depth === 0 && sans.length) {
          const m = /%clk\s+([\d:.]+)/.exec(body);
          if (m) clkArr[sans.length - 1] = parseClkSeconds(m[1]);
        }
        i = end === -1 ? movetext.length : end + 1;
        continue;
      }
      // next whitespace/brace-delimited token
      let j = i;
      while (j < movetext.length && !/[\s{}()]/.test(movetext[j])) j++;
      const tok = movetext.slice(i, j); i = j;
      if (depth > 0) continue;
      if (/^\d+\.{1,3}$/.test(tok) || /^\$\d+$/.test(tok) || isResult(tok)) continue;
      if (/^\d+\./.test(tok)) {                                  // "1.e4" glued form
        const rest = tok.replace(/^\d+\.{1,3}/, "");
        if (!rest) continue;
        if (!chess.move(rest, { sloppy: true })) return null;
        sans.push(chess.history().slice(-1)[0]); clkArr.length = sans.length;
        continue;
      }
      if (!chess.move(tok, { sloppy: true })) return null;       // illegal → untrustworthy game
      sans.push(chess.history().slice(-1)[0]);                   // normalised SAN (matches observed style)
      clkArr.length = sans.length;
    }
    if (!sans.length) return null;
    for (let k = 0; k < sans.length; k++) if (clkArr[k] === undefined) clkArr[k] = null;
    return { sans, clks: clkArr };
  }

  function parseFile(text) {
    const chunks = text.split(/(?=\[Event\s)/).filter(c => c.trim());
    const games = [];
    for (const c of (chunks.length ? chunks : [text])) {
      const g = parseGame(c);
      if (g) games.push(g);
    }
    return games;
  }

  /* --------------------------------------------------------- reconciling */

  const agreesWithObserved = (g, obs) => {
    const n = Math.min(g.sans.length, obs.length);
    for (let k = 0; k < n; k++) if (g.sans[k] !== obs[k]) return false;
    return true;
  };

  function setState(status, newClks, matchedLen) {
    const clksChanged = JSON.stringify(newClks) !== JSON.stringify(clks);
    if (status !== state.status || clksChanged) {
      state.status = status;
      state.matchedLen = matchedLen || 0;
      clks = newClks;
      state.rev++;
    }
  }

  function reconcile(games) {
    const obs = game.moves;
    if (!obs.length) { setState("waiting", [], 0); return; }
    const matched = games.filter(g => agreesWithObserved(g, obs));
    if (!matched.length) {
      // games exist, none agree — the irreconcilable case; observed drives
      setState("diverged", [], 0);
      return;
    }
    // Several matches (multi-board files share openings): fine if their clock
    // data agrees over the observed range; otherwise ambiguous — quiet.
    const range = (g) => JSON.stringify(g.clks.slice(0, obs.length));
    const first = matched[0];
    if (matched.some(g => range(g) !== range(first))) {
      setState("ambiguous", [], 0);
      return;
    }
    hadAgreement = true;
    setState("agree", first.clks.slice(), first.sans.length);
  }

  /* ------------------------------------------------------------ poll loop */

  let timer = null;

  async function tick() {
    const pc = (cfg.data.board && cfg.data.board.pgn) || {};
    const interval = Math.max(2000, Number(pc.poll_ms) || 6000);
    try {
      if (pc.enabled === false || game.demo) {
        setState(pc.enabled === false ? "off" : "absent", [], 0);
      } else {
        const r = await fetch("/api/pgn", { cache: "no-store" });
        const j = await r.json();
        if (!j.ok) {
          // no source (or probing disabled server-side): quiet. Keep last good
          // times if we ever agreed — retrieval failure must not blank a
          // populated column mid-broadcast.
          if (hadAgreement && state.status === "agree") { state.status = "stale"; state.rev++; }
          else if (state.status !== "stale") setState(j.status === "disabled" ? "off" : "absent", hadAgreement ? clks : [], state.matchedLen);
        } else {
          state.source = j.source || "";
          state.fetchedAt = j.fetched_at || 0;
          reconcile(parseFile(j.pgn));
          // The server holds its last good text through probe failures (so a
          // dying source never blanks anything); it flags that payload stale.
          // Surface the flag — internal state only, no visible change.
          if (j.stale && state.status === "agree") { state.status = "stale"; state.rev++; }
        }
      }
    } catch (e) {
      if (hadAgreement && state.status === "agree") { state.status = "stale"; state.rev++; }
    }
    timer = setTimeout(tick, interval);
  }

  /* ------------------------------------------------------------- output */

  // Per-move time for one ply from the matched PGN, or null. Only meaningful
  // while agreeing (or holding last-good through a stale spell). The first
  // move of each side has no earlier %clk baseline — null, observed covers it.
  function timeFor(ply) {
    if (state.status !== "agree" && state.status !== "stale") return null;
    if (ply < 2 || clks[ply] == null || clks[ply - 2] == null) return null;
    return Math.max(0, clks[ply - 2] - clks[ply]);
  }

  function init(g, configStore) {
    game = g;
    cfg = configStore;
    if (timer === null) tick();
  }

  return { init, state, timeFor };
})();
