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

   ---------------------------------------------------------------------------
   DESYNC RECOVERY (2026-07-21) — fixes the venue failure where the board
   stopped mirroring reality part-way through a game and never recovered.

   Holding an unreachable placement is right for a piece in hand, but it was
   the ONLY outcome: if the engine's position ever fell out of step with the
   physical board by more than it could explain as legal moves, every later
   placement was also unreachable, so it held forever. The board froze on air
   with no way back short of resetting the pieces to the start position (which
   throws the game away). The `LC_SNAP` "last-resort desync recovery" hook this
   file has always carried was declared and cleared but never armed — in the
   original single-file overlay too. Three changes close it:

   1. RIGHTS ARE INFERRED, NOT DISCARDED. Building a position from a bare
      placement used castling field "-", so once the overlay adopted a game in
      progress, castling was illegal for the rest of that game and the board
      seized the moment anyone castled. Rights are now inferred from where the
      kings and rooks actually stand. That can over-grant (a king that moved
      and came home looks unmoved) — deliberately: over-granting risks
      accepting one castling that was not legal, under-granting freezes the
      board permanently. Wrong-but-live beats right-but-dead on air.
   2. THE SEARCH GOES DEEPER WHEN IT IS WORTH IT. Depth 2 covers a missed poll;
      a longer stall (socket hiccup, throttled tab, operator adjusting pieces)
      needs more. Depth 3 runs only once a placement has proved stable, so the
      cost never lands on every poll.
   3. THE WATCHDOG IS ARMED. An unreachable placement is CLASSIFIED first:
        • removal-only (pieces missing, nothing added/moved) = hand in flight
          → hold indefinitely, exactly as before. Players hover for a long
          time; this must never be "recovered" from.
        • anything else = a settled position we cannot explain → hold briefly,
          then RESYNC to it: rebuild the engine position from the board and
          keep the move list. Never-wipe holds — history stays, the board
          starts mirroring reality again within seconds.
      Plus a manual force-resync for the operator (board.resync_token).

   The move list can lose the moves that happened during a desync. That is the
   accepted trade: an accurate board with a gap in the notation is worth far
   more on stream than a frozen board with a tidy list.
   ---------------------------------------------------------------------------

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
  let LC_LASTSEEN = null;       // last placement processed (dedupes polls)

  /* Hold/desync bookkeeping for the watchdog above. `kind` is "hand" for a
     removal-only diff (piece in flight — held indefinitely) or "desync" for a
     settled placement we cannot explain (resynced after resyncMs). */
  let held = null;              // { placement, kind, since, sightings, deepTried }
  let resyncMs = 4000;          // board.resync_ms
  let deepSearch = true;        // board.deep_search
  let curSerial = null;         // board serial the current model belongs to

  /* A feed gap (reconnect, or a socket recycled for going silent) means the
     moves played while we were away are simply gone. There is nothing to
     reconstruct, so the first position we cannot explain after a gap is adopted
     AT ONCE rather than held for the full resync window — holding would only
     keep a stale board on air. Set by livechess.js, cleared as soon as we are
     in step again. A position that is only pieces-lifted-off is still held:
     that is a hand in flight, gap or no gap. */
  let gapPending = false;
  function noteFeedGap() { gapPending = true; }

  /* A position built from a bare placement carries no side-to-move — the feed
     doesn't say, so adopting one is always a guess. If the guess is wrong the
     next real move looks unexplainable, which would cost a resync (and its
     delay) on every single move. So an adopted position is flagged UNCERTAIN,
     and while it is, an unexplainable placement is retried from the other side
     before anything else. One real move confirms the turn and clears the flag. */
  let turnUncertain = false;

  // Operator-visible diagnostics — read by the display heartbeat → admin.
  const diag = {
    state: "no board",          // no board | synced | hand | desync
    heldMs: 0,
    resyncs: 0,                 // automatic resyncs this session
    forced: 0,                  // manual force-resyncs
    unexplained: 0,             // placements we could not reconstruct
    deepHits: 0,                // gaps recovered by the depth-3 search
    gapAdopts: 0,               // boards picked up straight after a feed gap
    restored: 0,                // move lists restored from a display reload
    enginePlacement: "",
    boardPlacement: "",
  };

  /* ---- surviving a display reload --------------------------------------
     An OBS source refresh or a page reload throws the in-memory move list
     away, and the moves cannot be rebuilt from a single placement. So the
     observed model is mirrored to localStorage and restored on boot — but
     ONLY when the board is standing in exactly the position we saved, on the
     same serial, recently. An exact placement match is the proof that the
     history still belongs to what is on the table; anything else adopts the
     board with a fresh list (the board still comes up correct either way). */
  const SNAP_KEY = "scc.observed.snapshot";
  const SNAP_MAX_AGE_MS = 6 * 3600 * 1000;
  let snapTimer = null;

  function saveSnapshot() {
    clearTimeout(snapTimer);
    snapTimer = setTimeout(() => {
      try {
        if (!GAME || !game.moves.length) return;
        localStorage.setItem(SNAP_KEY, JSON.stringify({
          serial: curSerial || "", placement: placementOf(GAME.fen()), turn: GAME.turn(),
          moves: game.moves.slice(), times: obsTimes.slice(), at: Date.now(),
        }));
      } catch (e) { /* private mode / no storage — the board still works */ }
    }, 800);
  }

  function loadSnapshot(placement) {
    try {
      const s = JSON.parse(localStorage.getItem(SNAP_KEY) || "null");
      if (!s || !Array.isArray(s.moves) || !s.moves.length) return null;
      if (Date.now() - (Number(s.at) || 0) > SNAP_MAX_AGE_MS) return null;
      if (curSerial && s.serial && String(s.serial) !== String(curSerial)) return null;
      if (s.placement !== placement) return null;
      return s;
    } catch (e) { return null; }
  }

  function dropSnapshot() {
    try { localStorage.removeItem(SNAP_KEY); } catch (e) { }
  }

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
    turnUncertain = false;                     // a real move confirms whose turn it is
    saveSnapshot();                            // survive a display reload
  }

  function newGameFromStart() {                               // board reset to the initial position
    GAME = new Chess(); game.moves = []; game.currentPly = -1; game.lastMove = null;
    GAME_STARTED = false; game.started = false;
    held = null; gapPending = false; turnUncertain = false;   // start position: white to move, certain
    clearTimes(); dropSnapshot(); pushState();
  }

  /* ---- placement helpers ------------------------------------------------- */

  // Placement → 64 cells, index 0 = a8 … 63 = h1 (FEN reading order).
  function cellsOf(p) {
    const o = [];
    for (const row of String(p).split("/")) {
      for (const ch of row) { if (/\d/.test(ch)) { for (let k = 0; k < +ch; k++) o.push(""); } else o.push(ch); }
    }
    return o;
  }
  const FILES = "abcdefgh";
  const sqName = (i) => FILES[i % 8] + (8 - Math.floor(i / 8));
  const idxOf = (sq) => (8 - Number(sq[1])) * 8 + FILES.indexOf(sq[0]);
  const pieceAt = (cells, sq) => cells[idxOf(sq)] || "";

  // Castling availability inferred from where kings and rooks stand. See the
  // header note: over-granting is the deliberate, safe direction of error.
  function inferCastling(placement) {
    const c = cellsOf(placement);
    let r = "";
    if (pieceAt(c, "e1") === "K") { if (pieceAt(c, "h1") === "R") r += "K"; if (pieceAt(c, "a1") === "R") r += "Q"; }
    if (pieceAt(c, "e8") === "k") { if (pieceAt(c, "h8") === "r") r += "k"; if (pieceAt(c, "a8") === "r") r += "q"; }
    return r || "-";
  }

  // Build a chess.js position from a bare placement, keeping castling rights.
  // Falls back to no rights, then to a bare board, so this never throws.
  function buildChess(placement, turn) {
    const t = turn === "b" ? "b" : "w";
    for (const rights of [inferCastling(placement), "-"]) {
      try {
        const c = new Chess(placement + " " + t + " " + rights + " - 0 1");
        if (c && c.fen()) return c;
      } catch (e) { /* try the next, less permissive, form */ }
    }
    return null;
  }

  // first sync / desync recovery. keepMoves preserves the observed history
  // (never-wipe): the position is corrected, the notation so far stands.
  function adoptPosition(placement, keepMoves) {
    const c = buildChess(placement, game.toMove || "w");
    if (!c) return false;
    GAME = c;
    turnUncertain = true;                                     // the feed never told us whose move
    game.lastMove = null;                                     // unknown for an adopted position
    if (!keepMoves) { game.moves = []; game.currentPly = -1; clearTimes(); }
    else { game.currentPly = game.moves.length - 1; }
    pushState();
    return true;
  }

  // Squares that differ between two placements (as algebraic names, e.g. "e4").
  function changedSquares(p1, p2) {
    const a = cellsOf(p1), b = cellsOf(p2), set = new Set();
    for (let i = 0; i < 64; i++) { if (a[i] !== b[i]) set.add(sqName(i)); }
    return set;
  }

  // Is `target` just `current` with pieces LIFTED off it? That is a hand in
  // flight (or a capture in progress) — hold, never resync. Anything added or
  // relocated means the board has settled somewhere we cannot explain.
  function isRemovalOnly(current, target) {
    const a = cellsOf(current), b = cellsOf(target);
    let removed = 0;
    for (let i = 0; i < 64; i++) {
      if (a[i] === b[i]) continue;
      if (b[i] !== "") return false;                           // added or replaced → settled elsewhere
      removed++;
    }
    return removed > 0;
  }

  // Forward legal line from the current position to `target`, or null. Depth 1 covers every
  // normal move (incl. castling, promotion, en passant); deeper recovers a missed poll or a
  // longer stall. chess.js move generation is slow, so every level beyond the first is pruned
  // to moves touching a square that actually differs, and depth 3 is only ever spent on a
  // placement that has already proved stable (see the watchdog).
  function dfs(target, depth) {
    if (depth <= 0) return null;
    const changed = changedSquares(placementOf(GAME.fen()), target);
    for (const m of GAME.moves({ verbose: true })) {
      if (!changed.has(m.from) && !changed.has(m.to)) continue;
      GAME.move(m);
      let out = null;
      if (placementOf(GAME.fen()) === target) out = [m];
      else { const rest = dfs(target, depth - 1); if (rest) out = [m].concat(rest); }
      GAME.undo();
      if (out) return out;
    }
    return null;
  }

  function findSequence(target, maxDepth) {
    for (const m of GAME.moves({ verbose: true })) {          // depth 1: one move reaches it
      GAME.move(m); const hit = placementOf(GAME.fen()) === target; GAME.undo();
      if (hit) return [m];
    }
    if (maxDepth < 2) return null;
    return dfs(target, maxDepth);                              // depth 2..n, pruned
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
        pushState(); saveSnapshot(); return true;
      }
    }
    for (let i = undone.length - 1; i >= 0; i--) GAME.move(undone[i]);   // restore — not a takeback
    return false;
  }

  // Refresh the operator-facing diagnostics (and the reactive desync flag).
  function mark(now) {
    diag.enginePlacement = GAME ? placementOf(GAME.fen()) : "";
    diag.state = !GAME ? "no board" : held ? held.kind : "synced";
    diag.heldMs = held ? Math.max(0, now - held.since) : 0;
    if (game) game.desync = diag.state === "desync";
    if (!held) gapPending = false;             // in step again: the gap is closed
  }

  // Decides what to do about a placement we are currently holding. Called on
  // every poll (including the ones where nothing changed), so a stuck board is
  // measured in real time rather than in placement changes.
  function watchdog(now) {
    if (!held) { mark(now); return; }

    // A stable unexplained position earns the expensive search once.
    if (deepSearch && !held.deepTried && held.kind === "desync" && held.sightings >= 2) {
      held.deepTried = true;
      const seq = findSequence(held.placement, 3);
      if (seq && seq.length) {
        for (const m of seq) { GAME.move(m); commitMove(m); }
        diag.deepHits++; held = null; mark(now); return;
      }
    }

    // Still unexplained and settled: adopt the board as truth, keep the moves.
    if (held.kind === "desync" && now - held.since >= resyncMs && game.lcConnected !== false) {
      if (adoptPosition(held.placement, true)) { diag.resyncs++; held = null; saveSnapshot(); }
    }
    mark(now);
  }

  function applyPlacement(placement, serial) {
    placement = placementOf(placement);
    const now = Date.now();
    if (serial != null && serial !== "") curSerial = String(serial);
    diag.boardPlacement = placement;

    if (placement === LC_LASTSEEN) {                          // unchanged since last poll
      if (held) { held.sightings++; watchdog(now); }           // …but a hold is still on the clock
      return;
    }
    LC_LASTSEEN = placement;

    if (!GAME) {                                              // very first board data
      if (placement === START_PLACEMENT) newGameFromStart();
      else {
        // Restore the move list if this is the position we were last showing
        // (a reload mid-game); otherwise adopt the board with a fresh list.
        const snap = loadSnapshot(placement);
        const c = buildChess(placement, snap ? snap.turn : (game.toMove || "w"));
        if (c) {
          GAME = c;
          turnUncertain = !snap;               // a restored snapshot knows the turn
          game.lastMove = null;
          if (snap) {
            game.moves = snap.moves.slice();
            obsTimes = snap.times.slice();
            game.currentPly = game.moves.length - 1;
            GAME_STARTED = game.started = game.moves.length > 0;
            diag.restored++;
          } else {
            game.moves = []; game.currentPly = -1; clearTimes();
          }
          game.timesVersion++;
          pushState();
        }
      }
      held = null; gapPending = false; mark(now); return;
    }
    if (placement === START_PLACEMENT) {                      // reset to the initial position → fresh game
      if (placementOf(GAME.fen()) !== START_PLACEMENT || game.moves.length) newGameFromStart();
      held = null; mark(now); return;
    }
    if (placementOf(GAME.fen()) === placement) {              // already in sync
      held = null; mark(now); return;
    }

    const seq = findSequence(placement, 2);                   // add the move(s) just played
    if (seq && seq.length) {
      for (const m of seq) { GAME.move(m); commitMove(m); }
      held = null; mark(now); return;
    }
    if (tryTakeback(placement, 3)) { held = null; mark(now); return; }   // board went backward

    const removalOnly = isRemovalOnly(placementOf(GAME.fen()), placement);

    // Our side-to-move may simply be the wrong guess from an adopted position
    // (a fresh join, or picking the board up after a dropout). Retry from the
    // other side — this is what stops every move after an adopt costing a
    // resync. Skipped for a hand in flight, which no turn can explain.
    if (turnUncertain && !removalOnly) {
      const from = placementOf(GAME.fen()), other = (GAME.turn() === "w") ? "b" : "w";
      const test = buildChess(from, other);                   // rights inferred, not discarded
      if (test) {
        const saved = GAME;
        GAME = test;
        const seq2 = findSequence(placement, 2);
        if (seq2 && seq2.length) {
          for (const m of seq2) { GAME.move(m); commitMove(m); }
          held = null; mark(now); return;                     // commitMove clears turnUncertain
        }
        GAME = saved;                                         // no better: leave the model alone
      }
    }

    // UNREACHABLE from the game we are tracking. Classify it: pieces merely
    // lifted off is a hand in flight and is held indefinitely (players hover
    // for a long time); anything else has settled somewhere we cannot explain,
    // so the watchdog gives the search one more chance and then resyncs to it.
    const kind = removalOnly ? "hand" : "desync";
    if (!held || held.placement !== placement) {
      held = { placement, kind, since: now, sightings: 1, deepTried: false };
      diag.unexplained++;
    } else {
      held.kind = kind; held.sightings++;
    }

    // Straight after a feed gap there is nothing to reconstruct — pick the
    // board up now rather than holding a stale position for the resync window.
    if (kind === "desync" && gapPending) {
      gapPending = false;
      if (adoptPosition(placement, true)) {
        diag.gapAdopts++; held = null; saveSnapshot(); mark(now); return;
      }
    }
    watchdog(now);
  }

  /* ---- operator commands (admin) ---------------------------------------- */

  // Adopt what is physically on the board right now, keeping the move list.
  // The graceful fix for a board that has drifted out of step.
  function forceResync() {
    const p = diag.boardPlacement || (game && game.rawPlacement);
    if (!p) return false;
    const ok = adoptPosition(placementOf(p), true);
    if (ok) { diag.forced++; held = null; LC_LASTSEEN = placementOf(p); saveSnapshot(); mark(Date.now()); }
    return ok;
  }

  // Start a fresh game from the current physical position. This DOES clear the
  // move list — never automatic, only ever an explicit operator decision.
  function restartFromBoard() {
    const p = diag.boardPlacement || (game && game.rawPlacement);
    if (!p) return false;
    const ok = adoptPosition(placementOf(p), false);
    if (ok) {
      diag.forced++; held = null; LC_LASTSEEN = placementOf(p);
      GAME_STARTED = false; game.started = false; dropSnapshot(); mark(Date.now());
    }
    return ok;
  }

  // Tuning from config/board.json.
  function configure(b) {
    resyncMs = Math.max(1000, Number((b && b.resync_ms) != null ? b.resync_ms : 4000) || 4000);
    deepSearch = !(b && b.deep_search === false);
  }

  // Full model reset — ONLY for a genuine board-source change (different board
  // serial, or leaving demo mode). Never called from the placement path above.
  function reset() {
    GAME = null; GAME_STARTED = false; LC_LASTSEEN = null;
    held = null; gapPending = false; clearTimes(); dropSnapshot();
    game.moves = []; game.currentPly = -1; game.lastMove = null;
    game.fen = SCC.board.EMPTY_PLACEMENT; game.toMove = "w"; game.started = false;
    game.desync = false;
    diag.state = "no board"; diag.heldMs = 0; diag.enginePlacement = ""; diag.boardPlacement = "";
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
    if (!GAME) return { tracking: false, over: false, checkmate: false, stalemate: false, draw: false, check: false, turn: null };
    return {
      tracking: true,
      over: GAME.game_over(),
      checkmate: GAME.in_checkmate(),
      stalemate: GAME.in_stalemate(),
      draw: GAME.in_draw(),
      check: GAME.in_check(),        // side to move is in check (not mate) — for the check cue
      turn: GAME.turn(),
    };
  }

  return {
    init, applyPlacement, reset, renderList, gameStatus, syncClock, obsTime,
    configure, forceResync, restartFromBoard, noteFeedGap, diag,
    START_PLACEMENT, placementOf,
  };
})();
