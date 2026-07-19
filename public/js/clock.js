/* =========================================================================
   clock.js — clock parsing, formatting and the local ticking loop.
   Extracted from scc-stream-overlay.html; the logic is unchanged.

   The DGT clock feed only changes at move-end, so we tick the side-to-move
   down locally every second and re-sync to the real value ONLY when it
   changes (see livechess.js). Re-applying the feed value every poll freezes
   the display — that lesson is recorded in PROJECT-BRIEF.md; don't undo it.

   Classic script; exposes window.SCC.clock.
   ========================================================================= */
"use strict";
window.SCC = window.SCC || {};

SCC.clock = (function () {
  function parseClock(s) { if (typeof s !== "string") return null; const p = s.split(":").map(Number); if (p.some(n => isNaN(n))) return null; return p.reduce((a, n) => a * 60 + n, 0); }
  function fmtSec(t) { t = Math.max(0, Math.round(t)); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60; return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0"); }
  // LiveChess clock values arrive as "H:MM:SS" strings or numbers (ms or seconds).
  function lcClockSec(v) { if (v == null) return null; if (typeof v === "string") return parseClock(v); return v > 100000 ? Math.round(v / 1000) : Math.round(v); }

  let timer = null;
  // game.clockRunSide: 'w' | 'b' | null — null (before the game, or while both
  // clocks are stopped between moves) means nothing ticks; times just hold.
  // It is set from the LiveChess clock message (livechess.js).
  function start(game) {
    if (timer !== null) return;
    timer = setInterval(function () {
      if (!game.clockRunSide) return;              // no clock running -> don't count down
      const side = game.clockRunSide === "w" ? game.white : game.black;
      if (side.sec != null && side.sec > 0) { side.sec -= 1; }
    }, 1000);
  }

  return { parseClock, fmtSec, lcClockSec, start };
})();
