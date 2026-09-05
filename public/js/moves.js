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
   MOVE-LIST LAG (2026-08-15) — fixes the venue failure where the board mirrored
   perfectly but the NOTATION fell progressively behind: 22 plies played, 17 on
   the stream, and the deficit grew all game.

   The trade above was written for a rare emergency and was firing as routine,
   because two bugs turned every hiccup into permanent loss:

   1. THE RESYNC TIMER COULD NOT FIRE WHILE PLAY CONTINUED. The watchdog gate was
      `now - held.since >= resyncMs`, but `held` — and with it `since` — is
      rebuilt on every placement CHANGE. So the countdown restarted with each
      move and only ever expired once the board stopped. The model stayed frozen
      at its last explained position for the whole of a fast passage and the one
      resync at the end swallowed everything since: not k plies, UNBOUNDED. The
      episode is now timed separately (desyncSince) from the current placement.
   2. THE ONLY LOSS-FREE REPAIR NEVER RAN. The deeper search was gated on
      `held.sightings >= 2`, and sightings only increments when a placement
      arrives byte-identical to the one before. It therefore ran when the board
      was still and never while the players were moving — precisely backwards.
      It is now on a time rate limit.

   And nothing tried to RECOVER the moves before discarding them, although the
   information was in hand. Recovery is now a ladder (see reconcileTo): the
   LiveChess PGN first, which is authoritative; then a bounded search; and only
   then adopt-and-count. Every rung only ever APPENDS, so never-wipe still holds.

   What the search will NOT do is guess. A placement records where the pieces
   are, not how they got there, so beyond two plies several legal orderings reach
   the same position and reconstruction starts inventing moves nobody played
   (f1-b5-a4-b3 comes back as f1-c4-b3). Depth is capped where it is provably
   faithful; longer gaps are the PGN's job or they stay a gap. A short list is
   honest and a later PGN can still fill it in — a fabricated one is neither, and
   it poisons the PGN prefix match so the real moves can never be recovered.

   Gaps that could not be recovered are counted in diag.gaps rather than passing
   silently, and board.poll_ms now defaults to 300ms so that plies land inside a
   poll window far less often in the first place.
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

  /* How long we have been unable to explain the board — the DESYNC EPISODE, which
     is a different clock from held.since ("how long has this exact placement stood",
     which is what the hand-in-flight logic wants). They used to be the same field,
     and that was the engine of the venue lag: `held` is rebuilt with a fresh
     `since` on every placement CHANGE, so while play continued the resync timer was
     reset before it could ever expire. The model stayed frozen at its last explained
     position for the whole of a fast passage, and the single resync at the end
     swallowed every ply since. Measured on the repro harness: 80 plies played, one
     resync, move list empty, board perfectly correct. */
  let desyncSince = null;
  let lastDeepAt = 0;           // rate limit for the expensive recovery search

  /* SEARCH DEPTH IS A FIDELITY LIMIT, NOT A PERFORMANCE ONE.

     A placement says where the pieces are, never how they got there, so for a gap
     of several plies there are usually several legal orderings that arrive at the
     same position and the search has no way to know which was played. Measured
     against real games (tools/engine-selftest.js "reconstruction fidelity"):

        gap of 1 ply   → exact every time
        gap of 2 plies → exact every time
        gap of 3 plies → WRONG notation in 5 of 6 games
        gap of 4 plies → WRONG notation in 6 of 6
        gap of 5 plies → wrong notation AND the wrong number of moves

     e.g. a bishop played f1-b5-a4-b3 reconstructs as f1-c4-b3: same position,
     right piece, moves that were never played. So the search stops at 2. Deeper
     would make the move list keep up by inventing it, which on a broadcast is
     worse than being short — a viewer reading the notation would see moves nobody
     made, and the PGN reconciliation in pgn.js would then refuse to match the game
     at all, costing the accurate clock times too.

     Anything deeper than 2 is recovered from the LiveChess PGN, which is
     authoritative, or not at all. See reconcileTo. */
  const EXACT_DEPTH = 2;                          // the deepest provably faithful search
  /* One ply past the faithful limit, and no further. Proving uniqueness means
     enumerating EVERY line of that length rather than stopping at the first, which
     is far more expensive than an ordinary search — at depth 5 it does not finish
     inside a poll interval, let alone a frame. Depth 3 is affordable and covers
     the common miss (a poll window that swallowed a move pair plus a recapture).
     Anything longer is the PGN's job. */
  const UNIQUE_DEPTH = 3;
  const HOT_NODES = 20000;                        // every poll with a changed board
  const DEEP_NODES = 60000;                       // a desync still standing, rate limited
  const DEEP_MIN_GAP_MS = 700;                    // at most one recovery attempt per poll

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
    deepHits: 0,                // gaps closed by the recovery search (no moves lost)
    uniqueHits: 0,              // deeper gaps closed because only ONE line explained them
    pgnSplices: 0,              // gaps closed from the authoritative LiveChess PGN
    gaps: 0,                    // times the board was adopted with moves UNRECOVERABLE
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
          clocks: { w: game.white ? game.white.sec : null, b: game.black ? game.black.sec : null },
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

  /* The board is OFFLINE (LiveChess has lost it) and this display has seen no
     real placement yet — a reload, or an OBS source refresh, while the board is
     gone. There is nothing to hold, so hold what this display last showed: the
     snapshot's position, moves and clock values, when it is recent and belongs
     to this board. The same "last position stays on screen" policy, carried
     across a reload; without it the stream got an empty board and blank clocks.
     The first real placement is then judged exactly as after any gap: equal →
     in step, different → adopted. Returns true when something was restored. */
  function restoreLastKnown(serial) {
    if (GAME) return false;
    if (serial != null && serial !== "") curSerial = String(serial);
    let s = null;
    try { s = JSON.parse(localStorage.getItem(SNAP_KEY) || "null"); } catch (e) { s = null; }
    if (!s || !Array.isArray(s.moves) || !s.moves.length || !s.placement) return false;
    if (Date.now() - (Number(s.at) || 0) > SNAP_MAX_AGE_MS) return false;
    if (curSerial && s.serial && String(s.serial) !== String(curSerial)) return false;
    const c = buildChess(s.placement, s.turn);
    if (!c) return false;
    GAME = c;
    turnUncertain = false;                                    // the snapshot knows the turn
    game.lastMove = null;
    game.moves = s.moves.slice();
    obsTimes = Array.isArray(s.times) ? s.times.slice() : [];
    game.currentPly = game.moves.length - 1;
    GAME_STARTED = game.started = true;
    if (s.clocks && game.white && game.black) {
      if (s.clocks.w != null && game.white.sec == null) game.white.sec = s.clocks.w;
      if (s.clocks.b != null && game.black.sec == null) game.black.sec = s.clocks.b;
    }
    held = null; LC_LASTSEEN = null;                          // the first real placement is judged afresh
    diag.restored++;
    diag.boardPlacement = s.placement;                        // Resync / New game act on the last known board
    game.timesVersion++;
    pushState();
    mark(Date.now());
    return true;
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
    desyncSince = null;
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

  /* Whose move it is in an adopted position. The feed never says, so this was
     simply inherited from the frozen engine — correct only when an EVEN number of
     plies was swallowed, a coin flip in practice, and a wrong guess puts the wrong
     "X to move" on air and routes every later move through the retry path. One
     signal is available: a position in which the side NOT to move stands in check
     cannot have arisen, which rules out one of the two candidates. When neither is
     ruled out the inherited turn stands and turnUncertain covers the rest. */
  function legalTurn(placement, prefer) {
    const first = prefer === "b" ? "b" : "w";
    for (const t of [first, first === "w" ? "b" : "w"]) {
      const self = buildChess(placement, t);
      if (!self) continue;
      const other = buildChess(placement, t === "w" ? "b" : "w");
      if (other && other.in_check()) continue;   // side not to move is in check → impossible
      return t;
    }
    return first;
  }

  // first sync / desync recovery. keepMoves preserves the observed history
  // (never-wipe): the position is corrected, the notation so far stands.
  function adoptPosition(placement, keepMoves) {
    const c = buildChess(placement, legalTurn(placement, game.toMove || "w"));
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

  /* Forward legal line from the current position to `target`, or null. Depth 1 covers every
     normal move (incl. castling, promotion, en passant); deeper recovers a missed poll or a
     longer stall.

     SEARCH COST. This runs on the display's ONLY thread, between the board and the
     screen, so the worst case matters as much as the average. Two bounds:

       • THE ADMISSIBLE CUT. One ply changes at most FOUR squares — castling moves
         two pieces, en passant clears three, everything else two. So a target whose
         placement differs from ours on more than 4·depth squares cannot possibly be
         reached in `depth` plies, and the whole subtree is skipped without generating
         a single move. This is exact, not a heuristic: it never discards a reachable
         line. It is also what makes searching deeper than a couple of plies
         affordable at all — the cost only lands on targets that are genuinely close.
       • THE NODE BUDGET. Even so a pathological middlegame generates a lot of line.
         The budget stops the search dead rather than freezing the overlay; an
         exhausted search just reports "cannot explain", which every caller handles.

     The old code had neither, and a single unbounded search could block the page for
     seconds — long enough for livechess.js's silence watchdog to mistake a busy page
     for a dead feed, recycle the socket and declare a gap, which cost MORE moves. */
  const SQUARES_PER_PLY = 4;
  let searchNodes = 0, searchCap = 0;

  /* Every line of EXACTLY `depth` plies that reaches `target`, up to `limit` of
     them. Used to answer the only question that makes a deeper search honest: is
     there just ONE way the board could have got here?

     A placement records position, not history, so a deeper search normally has to
     guess between several legal orderings — and guessing puts moves on air that
     nobody played. But when the search finds exactly one line, it is not guessing:
     that is the only way the pieces could have arrived. So depth beyond the
     provably-faithful limit is allowed on that condition alone. Ambiguous gaps
     stay gaps, which is honest and leaves the PGN free to fill them in later. */
  function dfsAll(target, depth, out, limit) {
    if (depth <= 0 || out.length >= limit) return;
    const changed = changedSquares(placementOf(GAME.fen()), target);
    if (changed.size > SQUARES_PER_PLY * depth) return;        // provably unreachable
    for (const m of GAME.moves({ verbose: true })) {
      if (!changed.has(m.from) && !changed.has(m.to)) continue;
      if (++searchNodes > searchCap) return;                   // budget spent
      GAME.move(m);
      if (depth === 1) {
        if (placementOf(GAME.fen()) === target) out.push([m]);
      } else {
        const sub = [];
        dfsAll(target, depth - 1, sub, limit - out.length);
        for (const rest of sub) out.push([m].concat(rest));
      }
      GAME.undo();
      if (out.length >= limit) return;
    }
  }

  // The line to `target` at `depth`, but only if it is the ONLY one. null when
  // there are none, or more than one and therefore no way to know which was played.
  function findUnique(target, depth, nodeCap) {
    const before = GAME.fen();
    searchNodes = 0;
    searchCap = nodeCap || DEEP_NODES;
    try {
      const out = [];
      dfsAll(target, depth, out, 2);                           // two is enough to prove ambiguity
      if (searchNodes > searchCap) return null;                // truncated: cannot claim uniqueness
      return out.length === 1 ? out[0] : null;
    } catch (e) {
      return null;
    } finally {
      if (GAME.fen() !== before) { try { GAME = new Chess(before); } catch (e2) { } }
    }
  }

  // Lines of EXACTLY `depth` plies. Exactly, not "up to" — see findSequence.
  function dfs(target, depth) {
    if (depth <= 0) return null;
    const changed = changedSquares(placementOf(GAME.fen()), target);
    if (changed.size > SQUARES_PER_PLY * depth) return null;   // provably unreachable
    for (const m of GAME.moves({ verbose: true })) {
      if (!changed.has(m.from) && !changed.has(m.to)) continue;
      if (++searchNodes > searchCap) return null;              // budget spent
      GAME.move(m);
      let out = null;
      if (depth === 1) { if (placementOf(GAME.fen()) === target) out = [m]; }
      else { const rest = dfs(target, depth - 1); if (rest) out = [m].concat(rest); }
      GAME.undo();
      if (out) return out;
    }
    return null;
  }

  /* A search walks GAME forward with move() and unwinds itself with undo(). If an
     exception ever escaped mid-recursion the unwinding never happened, and GAME was
     left half-advanced and permanently corrupt — from then on every poll threw and
     nothing was ever committed again, so the move list froze for the rest of the
     broadcast. The position is captured up front and restored if the search did not
     leave it as it found it, so a bad search costs one poll instead of the game. */
  function findSequence(target, maxDepth, nodeCap) {
    const before = GAME.fen();
    searchNodes = 0;
    searchCap = nodeCap || HOT_NODES;
    try {
      for (const m of GAME.moves({ verbose: true })) {        // depth 1: one move reaches it
        GAME.move(m); const hit = placementOf(GAME.fen()) === target; GAME.undo();
        if (hit) return [m];
      }
      /* ITERATIVE DEEPENING — shortest line first, and it must be the shortest.
         A placement carries no move count, so several line lengths can reach the
         same one; a plain depth-first search to the maximum depth happily returns
         a 3-ply line where 2 plies were played, which puts moves on air that were
         never made and leaves the move list AHEAD of the board. Trying each depth
         in turn returns the fewest plies that explain what we can see, which is
         both the honest reading and the one that matches reality in normal play.
         Re-searching the shallow depths is cheap next to getting this wrong. */
      for (let d = 2; d <= maxDepth; d++) {
        const seq = dfs(target, d);
        if (seq) return seq;
        if (searchNodes > searchCap) break;                    // budget spent
      }
      return null;
    } catch (e) {
      return null;                                             // unexplainable, not fatal
    } finally {
      if (GAME.fen() !== before) {                             // the search did not unwind
        try { GAME = new Chess(before); } catch (e2) { /* keep what we have */ }
      }
    }
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

  /* THE RECOVERY LADDER — run before anything is allowed to adopt the board.
     A resync used to adopt the physical position and silently drop every ply played
     during the window. The board caught up; the notation never did, and because
     nothing ever went back for those moves the deficit was permanent and grew with
     every incident. That is the venue fault: 22 plies on the board, 17 on the
     stream. So the moves are RECOVERED first, from the best source available:

       1. THE PGN — authoritative. LiveChess serves the real game; pgn.js already
          fetches, parses and validates it by full replay. At this exact moment our
          observed list is still a valid PREFIX of that game (we simply have not
          added the new plies yet), so the missing plies can be read straight off.
          This gives the real move ORDER, which a search cannot: a placement carries
          no ordering, so any multi-ply reconstruction is one legal permutation
          among several.
       2. A BOUNDED SEARCH — LiveChess often serves no PGN at all, which the header
          of pgn.js calls a normal state. Search forward from the tracked position,
          deeper than the hot path, bounded by the admissible cut and a node budget.
       3. GIVE UP AND COUNT IT — the caller adopts, the board still wins over the
          notation (that trade stands), but it is now the last resort rather than
          the first, and diag.gaps makes it visible instead of silent.

     Only ever APPENDS to the move list, so NEVER-WIPE-MOVES is untouched. */
  function reconcileTo(placement, depth, nodes) {
    if (!GAME) return false;
    if (placementOf(GAME.fen()) === placement) return true;

    // 1. authoritative: replay the plies the PGN already knows about
    const sans = (typeof SCC !== "undefined" && SCC.pgn && SCC.pgn.matchedSans) ? SCC.pgn.matchedSans() : null;
    if (sans && sans.length > game.moves.length) {
      const n = game.moves.length;
      let probe = null;
      try { probe = new Chess(GAME.fen()); } catch (e) { probe = null; }
      const line = [];
      if (probe) {
        for (let i = n; i < sans.length; i++) {
          let m = null;
          try { m = probe.move(sans[i], { sloppy: true }); } catch (e) { m = null; }
          if (!m) break;
          line.push(m);
          if (placementOf(probe.fen()) === placement) break;
        }
      }
      if (line.length && probe && placementOf(probe.fen()) === placement) {
        for (const m of line) {
          let mm = null;
          try { mm = GAME.move(m.san, { sloppy: true }); } catch (e) { mm = null; }
          if (mm) commitMove(mm);
        }
        if (placementOf(GAME.fen()) === placement) { diag.pgnSplices++; return true; }
      }
    }

    // 2. search forward for a legal line that reaches the board
    const seq = findSequence(placement, depth || EXACT_DEPTH, nodes || DEEP_NODES);
    if (seq && seq.length) {
      for (const m of seq) { GAME.move(m); commitMove(m); }
      diag.deepHits++;
      return true;
    }

    // 3. deeper than the faithful limit, but only where the answer is forced.
    // Shortest first, so an unambiguous short explanation always wins over a
    // longer one, and stop at the first depth that has any line at all —
    // beyond that we would be choosing between orderings again.
    for (let d = EXACT_DEPTH + 1; d <= UNIQUE_DEPTH; d++) {
      const only = findUnique(placement, d, DEEP_NODES);
      if (only) {
        for (const m of only) { GAME.move(m); commitMove(m); }
        diag.uniqueHits++;
        return true;
      }
    }
    return false;
  }

  // Refresh the operator-facing diagnostics (and the reactive desync flag).
  function mark(now) {
    diag.enginePlacement = GAME ? placementOf(GAME.fen()) : "";
    diag.state = !GAME ? "no board" : held ? held.kind : "synced";
    diag.heldMs = held ? Math.max(0, now - held.since) : 0;
    if (game) game.desync = diag.state === "desync";
    if (!held) { gapPending = false; desyncSince = null; }   // in step again: episode over
  }

  // Decides what to do about a placement we are currently holding. Called on
  // every poll (including the ones where nothing changed), so a stuck board is
  // measured in real time rather than in placement changes.
  function watchdog(now) {
    if (!held) { mark(now); return; }

    /* An unexplained position earns the recovery search. This used to be gated on
       held.sightings >= 2 — "the placement has stood still for two polls" — and
       sightings only ever increments when the incoming placement is byte-identical
       to the last one. So while the players kept moving the gate never opened and
       the ONLY loss-free repair in the system never ran during play: it fired when
       the board paused and did nothing when it mattered. It is now gated on a plain
       time rate limit instead, so it runs during a burst, and once per poll at most
       so placement churn cannot multiply its cost. */
    if (deepSearch && held.kind === "desync" && now - lastDeepAt >= DEEP_MIN_GAP_MS) {
      lastDeepAt = now;
      held.deepTried = true;
      if (reconcileTo(held.placement, EXACT_DEPTH, DEEP_NODES)) { held = null; mark(now); return; }
    }

    // Still unexplained and settled: one last, deeper try at recovering the moves,
    // and only then adopt the board as truth and keep what notation we have.
    if (held.kind === "desync" && desyncSince != null && now - desyncSince >= resyncMs && game.lcConnected !== false) {
      if (reconcileTo(held.placement, EXACT_DEPTH, DEEP_NODES)) { held = null; mark(now); saveSnapshot(); return; }
      if (adoptPosition(held.placement, true)) { diag.resyncs++; diag.gaps++; held = null; saveSnapshot(); }
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

    const seq = findSequence(placement, EXACT_DEPTH, HOT_NODES); // add the move(s) just played
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
        // The swap is exception-safe: GAME ends up either the successfully advanced
        // test instance or back to `saved`. It used to be neither — a throw inside
        // the search skipped the restore and left the corrupt instance installed,
        // and every poll after that threw too.
        const saved = GAME;
        let seq2 = null;
        GAME = test;
        try { seq2 = findSequence(placement, EXACT_DEPTH, HOT_NODES); } catch (e) { seq2 = null; }
        if (seq2 && seq2.length) {
          try {
            for (const m of seq2) { GAME.move(m); commitMove(m); }
            held = null; mark(now); return;                   // commitMove clears turnUncertain
          } catch (e) { GAME = saved; }                       // engine trouble: keep the good model
        } else {
          GAME = saved;                                       // no better: leave the model alone
        }
      }
    }

    // UNREACHABLE from the game we are tracking. Classify it: pieces merely
    // lifted off is a hand in flight and is held indefinitely (players hover
    // for a long time); anything else has settled somewhere we cannot explain,
    // so the watchdog tries to recover the moves and only then resyncs to it.
    const kind = removalOnly ? "hand" : "desync";
    // The episode clock starts at the FIRST unexplained placement and survives the
    // board moving on; held.since restarts with each new placement and is only the
    // hand-in-flight clock. Conflating them is what stopped the watchdog firing.
    if (kind === "desync") { if (desyncSince == null) desyncSince = now; }
    else desyncSince = null;
    if (!held || held.placement !== placement) {
      held = { placement, kind, since: now, sightings: 1, deepTried: false };
      diag.unexplained++;
    } else {
      held.kind = kind; held.sightings++;
    }

    // Straight after a feed gap, pick the board up now rather than holding a stale
    // position for the resync window — but try to recover the moves first. The
    // header's "across a dropout there is nothing to reconstruct" holds for a long
    // outage; it is wrong for the one-poll hiccup that the silence watchdog also
    // reports as a gap, where the missing plies are well within reach.
    if (kind === "desync" && gapPending) {
      gapPending = false;
      if (reconcileTo(placement, EXACT_DEPTH, DEEP_NODES)) {
        held = null; saveSnapshot(); mark(now); return;
      }
      if (adoptPosition(placement, true)) {
        diag.gapAdopts++; diag.gaps++; held = null; saveSnapshot(); mark(now); return;
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
    // Recover the moves before adopting, same ladder as the watchdog. The operator
    // reaches for this button exactly when the board looks wrong on air — i.e. mid
    // desync, when there are usually reconstructable plies to save. It used to
    // throw them away with no search at all.
    if (reconcileTo(placementOf(p), EXACT_DEPTH, DEEP_NODES)) {
      diag.forced++; held = null; LC_LASTSEEN = placementOf(p); saveSnapshot(); mark(Date.now());
      return true;
    }
    const ok = adoptPosition(placementOf(p), true);
    if (ok) { diag.forced++; diag.gaps++; held = null; LC_LASTSEEN = placementOf(p); saveSnapshot(); mark(Date.now()); }
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
    held = null; gapPending = false; desyncSince = null; clearTimes(); dropSnapshot();
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
    if (!GAME) return { tracking: false, over: false, checkmate: false, stalemate: false, draw: false, check: false, turn: null, turn_certain: false };
    return {
      tracking: true,
      over: GAME.game_over(),
      checkmate: GAME.in_checkmate(),
      stalemate: GAME.in_stalemate(),
      draw: GAME.in_draw(),
      check: GAME.in_check(),        // side to move is in check (not mate) — for the check cue
      turn: GAME.turn(),
      // false while the turn is inherited rather than observed (a position
      // adopted across a feed gap carries no side to move). The clock's
      // ticking-side resolution will not lean on the turn unless it is true.
      turn_certain: !turnUncertain,
    };
  }

  return {
    init, applyPlacement, reset, renderList, gameStatus, syncClock, obsTime,
    configure, forceResync, restartFromBoard, noteFeedGap, restoreLastKnown, diag,
    START_PLACEMENT, placementOf,
  };
})();
