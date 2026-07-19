/* =========================================================================
   board.js — board rendering, extracted from scc-stream-overlay.html.
   The DOM it produces is identical to the original renderBoard(); it is now
   parameterized (element + view state) and driven by a Vue watcher instead
   of the old global render() calls.

   Classic script; exposes window.SCC.board.
   ========================================================================= */
"use strict";
window.SCC = window.SCC || {};

SCC.board = (function () {
  /* both sides use the SOLID glyph shapes; colour (.pc.w cream / .pc.b dark) tells them apart */
  const GLYPH = { K: "♚", Q: "♛", R: "♜", B: "♝", N: "♞", P: "♟", k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
  const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const EMPTY_PLACEMENT = "8/8/8/8/8/8/8/8";

  function squareName(col, row) { return FILES[col] + (8 - row); }

  // view: { fen, lastMove } — only the placement field of the FEN is read.
  function render(el, view) {
    el.innerHTML = "";
    const rows = String(view.fen).split(" ")[0].split("/");
    for (let r = 0; r < 8; r++) {
      let c = 0;
      const cells = [];
      for (const ch of rows[r] || "8") {
        if (/\d/.test(ch)) { for (let k = 0; k < +ch; k++) { cells.push(null); c++; } }
        else { cells.push(ch); c++; }
      }
      for (let col = 0; col < 8; col++) {
        const piece = cells[col];
        const isLight = (r + col) % 2 === 0;
        const name = squareName(col, r);
        const sq = document.createElement("div");
        sq.className = "sq " + (isLight ? "light" : "dark");
        if (view.lastMove && (view.lastMove.from === name || view.lastMove.to === name)) sq.classList.add("hi");
        if (piece) {
          const p = document.createElement("div");
          p.className = "pc " + (piece === piece.toUpperCase() ? "w" : "b");
          p.textContent = GLYPH[piece];
          sq.appendChild(p);
        }
        // coordinates: files on bottom rank, ranks on left file
        if (r === 7) { const f = document.createElement("div"); f.className = "coord file " + (isLight ? "on-light" : "on-dark"); f.textContent = FILES[col]; sq.appendChild(f); }
        if (col === 0) { const rk = document.createElement("div"); rk.className = "coord rank " + (isLight ? "on-light" : "on-dark"); rk.textContent = (8 - r); sq.appendChild(rk); }
        el.appendChild(sq);
      }
    }
  }

  return { render, EMPTY_PLACEMENT, GLYPH, FILES, squareName };
})();
