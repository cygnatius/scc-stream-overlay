/* =========================================================================
   moves.js — the OBSERVED move model + move-list rendering.
   Extracted from scc-stream-overlay.html. The reconstruction algorithm is
   unchanged; the old STATE/GAME globals are now the bound reactive `game`
   object and a module-internal chess.js instance.

   Move reconstruction from the DGT board feed.
   The eboards feed only gives the current piece PLACEMENT (no move list), so we
   rebuild the moves ourselves. GAME (chess.js) is our source of truth. Guiding
   rule: once we're tracking a game we NEVER throw its moves away. Each new
   placement can only ADD reconstructed move(s) or apply an explicit takeback;
   an unreachable placement (a piece physically mid-move) is simply ignored and
   the last good position is held until the move completes. The one clean reset
   is the standard starting position, which begins a fresh game.

   THE NEVER-WIPE-MOVES RULE IS ABSOLUTE. It predates this refactor and it
   survives it unchanged.

   Classic script; exposes window.SCC.moves. Requires vendor/chess-0.10.3
   (classic global build — 0.13+/1.x are ES modules and break; do not upgrade).
   ========================================================================= */
"use strict";
window.SCC = window.SCC || {};

SCC.moves = (function () {
  const START_PLACEMENT = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";

  let game = null;              // bound reactive game state (fen, moves, toMove, …)
  let GAME = null;              // chess.js instance — the source of truth
  let GAME_STARTED = false;
  let LC_SNAP = null;
  let LC_LASTSEEN = null;       // last placement processed (dedupes polls)

  /* OBSERVED per-move times (stage 5). obsTimes[ply] = seconds the mover
     spent, or null. Committed with a PROVISIONAL value from the locally
     ticking clock, then REFINED at the next feed clock sync — the DGT feed
     only changes a clock value at move-end, so the synced value is exact.
     Strictly parallel to game.moves; wiped only where the move list is. */
  let obsTimes = [];
  let lastClk = { w: null, b: null };   // clock baseline per side, from feed syncs only
  let lastPly = { w: null, b: null };   // last committed ply per side (for refinement)

  function init(g) { game = g; if (g.timesVersion === undefined) g.timesVersion = 0; }

  function clearTimes() {
    obsTimes = []; lastClk = { w: null, b: null }; lastPly = { w: null, b: null };
    if (game) game.timesVersion++;
  }

  function clockOf(c) {
    const s = c === "w" ? game.white.sec : game.black.sec;
    return s == null ? null : s;
  }

  // Feed clock sync for one side (livechess.js calls this on real changes).
  // Refines the provisional time of that side's last move, then becomes the
  // baseline for their next one. A sync with no move yet is the baseline too
  // (the pre-game clock message).
  function syncClock(c, sec) {
    if (sec == null) return;
    if (lastPly[c] != null && lastClk[c] != null) {
      obsTimes[lastPly[c]] = Math.max(0, lastClk[c] - sec);
      game.timesVersion++;
    }
    lastClk[c] = sec;
    lastPly[c] = null;                    // refined once; later syncs are between-move noise
  }

  function obsTime(ply) { return obsTimes[ply] != null ? obsTimes[ply] : null; }

  function placementOf(fen) { return String(fen).split(" ")[0]; }
  function pushState() { game.fen = GAME.fen(); game.toMove = GAME.turn(); }

  function commitMove(m) {
    game.moves.push(m.san);
    game.currentPly = game.moves.length - 1;
    game.lastMove = { from: m.from, to: m.to };
    game.fen = GAME.fen();
    game.toMove = GAME.turn();
    GAME_STARTED = true;
    game.started = true;
    // provisional time spent: baseline minus the mover's locally-ticked clock
    // (the exact feed value refines it moments later via syncClock)
    const c = m.color, cur = clockOf(c);
    obsTimes.push(lastClk[c] != null && cur != null ? Math.max(0, lastClk[c] - cur) : null);
    lastPly[c] = game.moves.length - 1;
    game.timesVersion++;
  }

  function newGameFromStart() {                               // board reset to the initial position
    GAME = new Chess(); game.moves = []; game.currentPly = -1; game.lastMove = null;
    GAME_STARTED = false; game.started = false;
    clearTimeout(LC_SNAP); LC_SNAP = null; clearTimes(); pushState();
  }

  function adoptPosition(placement) {                         // first sync / last-resort desync recovery
    // We have no trustworthy move history for this position, so start a clean list from here.
    try { GAME = new Chess(placement + " " + (game.toMove || "w") + " - - 0 1"); } catch (e) { return false; }
    game.moves = []; game.currentPly = -1; game.lastMove = null; clearTimes(); pushState(); return true;
  }

  // Squares that differ between two placements (as algebraic names, e.g. "e4").
  function changedSquares(p1, p2) {
    const cells = p => { const o = []; for (const row of p.split("/")) { for (const ch of row) { if (/\d/.test(ch)) { for (let k = 0; k < +ch; k++) o.push(""); } else o.push(ch); } } return o; };
    const a = cells(p1), b = cells(p2), files = "abcdefgh", set = new Set();
    for (let i = 0; i < 64; i++) { if (a[i] !== b[i]) set.add(files[i % 8] + (8 - Math.floor(i / 8))); }
    return set;
  }

  // Forward legal line from the current position to `target`, or null. Depth 1 covers every
  // normal move (incl. castling, promotion, en passant); depth 2 recovers the rare case where
  // a poll was missed between two moves (e.g. a capture + recapture). Kept deliberately cheap —
  // chess.js move generation is slow, so we never do a deep blind search on every poll.
  function findSequence(target, maxDepth) {
    for (const m of GAME.moves({ verbose: true })) {          // depth 1: one move reaches it
      GAME.move(m); const hit = placementOf(GAME.fen()) === target; GAME.undo();
      if (hit) return [m];
    }
    if (maxDepth < 2) return null;
    const changed = changedSquares(placementOf(GAME.fen()), target);   // depth 2: prune to moves that touch the diff
    for (const m of GAME.moves({ verbose: true })) {
      if (!changed.has(m.from) && !changed.has(m.to)) continue;
      GAME.move(m);
      let found = null;
      for (const m2 of GAME.moves({ verbose: true })) {
        GAME.move(m2); const hit = placementOf(GAME.fen()) === target; GAME.undo();
        if (hit) { found = [m, m2]; break; }
      }
      GAME.undo();
      if (found) return found;
    }
    return null;
  }

  // Board moved BACKWARD (a takeback of 1..maxBack half-moves). Returns true if applied.
  function tryTakeback(target, maxBack) {
    const undone = [];
    for (let i = 0; i < maxBack; i++) {
      const b = GAME.undo(); if (!b) break; undone.push(b);
      if (placementOf(GAME.fen()) === target) {
        for (let k = 0; k < undone.length; k++) { game.moves.pop(); obsTimes.pop(); }
        // clock baselines are meaningless across a takeback (the operator may
        // wind the clocks); re-baseline from the next feed syncs
        lastClk = { w: null, b: null }; lastPly = { w: null, b: null };
        game.timesVersion++;
        const h = GAME.history({ verbose: true }), l = h[h.length - 1];
        game.currentPly = game.moves.length - 1; game.lastMove = l ? { from: l.from, to: l.to } : null;
        pushState(); return true;
      }
    }
    for (let i = undone.length - 1; i >= 0; i--) GAME.move(undone[i]);   // restore — not a takeback
    return false;
  }

  function applyPlacement(placement) {
    placement = placementOf(placement);
    if (placement === LC_LASTSEEN) return;                    // unchanged since last poll (incl. a held transient)
    LC_LASTSEEN = placement;
    clearTimeout(LC_SNAP); LC_SNAP = null;                    // placement changed → cancel any pending recovery

    if (!GAME) {                                              // very first board data: adopt what's on the board
      if (placement === START_PLACEMENT) newGameFromStart(); else adoptPosition(placement);
      return;
    }
    if (placement === START_PLACEMENT) {                      // reset to the initial position → fresh game
      if (placementOf(GAME.fen()) !== START_PLACEMENT || game.moves.length) newGameFromStart();
      return;
    }
    if (placementOf(GAME.fen()) === placement) return;        // already in sync

    const seq = findSequence(placement, 2);                   // add the move(s) just played
    if (seq && seq.length) { for (const m of seq) { GAME.move(m); commitMove(m); } return; }
    if (tryTakeback(placement, 2)) return;                    // board went backward

    // Fresh join with an unknown side-to-move: when we adopt a game already in progress we
    // have to guess whose move it is. If that guess was wrong the first real move looks
    // unreachable — so, ONLY while we still have no moves recorded (nothing to lose), try the
    // other side before giving up. This never touches a game we're actually tracking.
    if (game.moves.length === 0) {
      const cur = placementOf(GAME.fen()), other = (GAME.turn() === "w") ? "b" : "w";
      let test; try { test = new Chess(cur + " " + other + " - - 0 1"); } catch (e) { test = null; }
      if (test) for (const m of test.moves({ verbose: true })) {
        test.move(m);
        if (placementOf(test.fen()) === placement) { GAME = test; commitMove(m); return; }
        test.undo();
      }
    }

    // Otherwise the placement is UNREACHABLE from the game we're tracking. This is almost
    // always a piece physically mid-move (lifted while the player thinks) — so we simply HOLD
    // the last good position and wait; when the piece lands, that move is added. We NEVER wipe
    // or rebuild the move list here — that was the bug. If the board is ever genuinely out of
    // sync (pieces knocked over / rearranged), reset it to the starting position to resync.
  }

  // Full model reset — ONLY for a genuine board-source change (different board
  // serial, or leaving demo mode). Never called from the placement path above.
  function reset() {
    GAME = null; GAME_STARTED = false; LC_LASTSEEN = null;
    clearTimeout(LC_SNAP); LC_SNAP = null; clearTimes();
    game.moves = []; game.currentPly = -1; game.lastMove = null;
    game.fen = SCC.board.EMPTY_PLACEMENT; game.toMove = "w"; game.started = false;
  }

  /* ---- moves list rendering (same DOM as the original renderMoves) ------ */
  // "0:07" / "1:23" / "1:02:03" — per-move time spent
  function fmtSpent(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0")
      : m + ":" + String(s).padStart(2, "0");
  }

  // times: optional array of seconds|null per ply. A ply without a time (or
  // no array at all) renders exactly the classic cell — plain SAN text.
  function renderList(el, g, times) {
    el.innerHTML = "";
    const pairs = Math.ceil(g.moves.length / 2);
    for (let i = 0; i < pairs; i++) {
      const no = document.createElement("div"); no.className = "mno"; no.textContent = (i + 1) + ".";
      el.appendChild(no);
      for (let s = 0; s < 2; s++) {
        const ply = i * 2 + s;
        const cell = document.createElement("div");
        if (ply < g.moves.length) {
          const t = times ? times[ply] : null;
          cell.className = "mv" + (t != null ? " has-t" : "") + (ply === g.currentPly ? " cur" : "");
          if (t != null) {
            const san = document.createElement("span"); san.textContent = g.moves[ply];
            const tm = document.createElement("span"); tm.className = "mvt"; tm.textContent = fmtSpent(t);
            cell.appendChild(san); cell.appendChild(tm);
          } else {
            cell.textContent = g.moves[ply];
          }
        } else { cell.className = "mv"; cell.textContent = ""; }
        el.appendChild(cell);
      }
    }
    // keep newest visible
    el.scrollTop = el.scrollHeight;
  }

  // Read-only view of the tracked game for the scene auto-detector.
  // Uses the internal chess.js instance; never mutates it.
  function gameStatus() {
    if (!GAME) return { tracking: false, over: false, checkmate: false, stalemate: false, draw: false, turn: null };
    return {
      tracking: true,
      over: GAME.game_over(),
      checkmate: GAME.in_checkmate(),
      stalemate: GAME.in_stalemate(),
      draw: GAME.in_draw(),
      turn: GAME.turn(),
    };
  }

  return { init, applyPlacement, reset, renderList, gameStatus, syncClock, obsTime, START_PLACEMENT, placementOf };
})();
