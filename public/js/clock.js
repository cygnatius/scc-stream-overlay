/* =========================================================================
   clock.js — clock parsing, formatting and the local ticking loop.

   The DGT clock feed only changes at move-end, so we tick the side-to-move
   down locally and re-sync to the real value ONLY when it changes (see
   livechess.js). Re-applying the feed value every poll freezes the display —
   that lesson is recorded in PROJECT-BRIEF.md; don't undo it.

   The countdown is WALL-TIME ANCHORED, not decrement-per-fire. The original
   loop subtracted one second per interval fire, so every throttled or late
   timer fire silently LOST time — under browser tab throttling or a loaded
   OBS the on-screen clock fell behind the real one and looked frozen. Now an
   anchor {sec, at} is taken whenever the running side changes or the value
   is set from outside (a feed sync), and each fire COMPUTES the value from
   real elapsed time — a late fire lands on the correct second instead of
   drifting. The interval runs at 250 ms so re-anchoring is prompt; cadence
   no longer affects the rate at all.

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
    // anchor: the running side's true value at a known wall time. lastWritten
    // detects an outside write (feed sync / resync) — any value we didn't put
    // there ourselves re-anchors, so a sync mid-think restarts the countdown
    // from the exact feed value.
    let anchor = null;                   // { side, sec, at, lastWritten }
    timer = setInterval(function () {
      const s = game.clockRunSide;
      if (!s) { anchor = null; return; } // no clock running -> hold, forget the anchor
      const obj = s === "w" ? game.white : game.black;
      if (obj.sec == null) { anchor = null; return; }
      if (!anchor || anchor.side !== s || obj.sec !== anchor.lastWritten) {
        anchor = { side: s, sec: obj.sec, at: Date.now(), lastWritten: obj.sec };
        return;
      }
      const next = Math.max(0, anchor.sec - Math.floor((Date.now() - anchor.at) / 1000));
      if (next !== obj.sec) {
        obj.sec = next;
        anchor.lastWritten = next;
      }
    }, 250);
  }

  return { parseClock, fmtSec, lcClockSec, start };
})();
