/* =========================================================================
   livechess.js — DGT LiveChess connection (board, moves, clocks).
   Extracted from scc-stream-overlay.html. The feed handling is unchanged;
   what's new around it:

     • config-driven: host defaults to 127.0.0.1 (LiveChess runs on this
       machine). manual_host_override supports the two-machine venue fallback.
     • reconnect with exponential backoff capped at 5s (1→2→4→5). A long
       ceiling means a board dropout costs dead overlay time on air, so the
       cap is deliberately tight. Resets to 1s on a successful open.
     • apply(cfg) diffs config changes: the connection restarts ONLY when the
       effective host or serial actually changed; the move model resets ONLY
       on a serial change (a different physical board is a different game).
       Unrelated config writes never touch the connection or the move list.
     • demo_mode: shows the original built-in demo game instead of connecting.
       Fake names must never reach air by accident, so this defaults OFF and
       the admin page shows a persistent indicator while it's on.

   Classic script; exposes window.SCC.livechess.
   ========================================================================= */
"use strict";
window.SCC = window.SCC || {};

SCC.livechess = (function () {
  // The original demo STATE, preserved verbatim — shown only when demo_mode is on.
  const DEMO = {
    fen: "r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4",
    lastMove: { from: "a7", to: "a6" },
    toMove: "w",
    moves: ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"],
    currentPly: 5,
    white: { name: "White Name", title: "", flag: "🇦🇺", rating: 1685, record: "3½ / 4", clock: "1:12:44" },
    black: { name: "Black Name", title: "CM", flag: "🇦🇺", rating: 1802, record: "4 / 4", clock: "0:58:07" },
  };

  let game = null;

  let ws = null, pollTimer = null, reconnectTimer = null, monitorTimer = null;

  /* ---- request pacing ---------------------------------------------------
     THE VENUE CONNECTION LOOP (Aug 2026). The poll used to fire an eboards
     request every poll_ms regardless of whether LiveChess had answered the
     previous one. LiveChess serves requests one at a time; a board/PC that
     takes longer than poll_ms per request builds an unbounded backlog (bench:
     68 queued after 20 s at 300 ms polling vs a 1 s LiveChess), every reply
     is staler than the last, and once a reply is more than 5 s behind the
     silence watchdog tears the socket down — whose first request then waits
     behind the old backlog and trips the watchdog again. A permanent
     connect → silent → reconnect loop that looked like "the board won't
     connect", while LiveChess itself was fine.
     Now: ONE request in flight at a time. The next is sent poll_ms after the
     reply (or after REPLY_TIMEOUT_MS if LiveChess never answers, so a dead
     feed still reaches the watchdog). A fast LiveChess sees exactly the old
     cadence; a slow one is polled at its own pace, no backlog, fresh data. */
  const REPLY_TIMEOUT_MS = 2500;
  let awaitingReply = false;
  let sentAt = 0;

  function sendPoll() {
    if (!ws || ws.readyState !== 1) return;            // not OPEN
    if (awaitingReply && Date.now() - sentAt < REPLY_TIMEOUT_MS) {
      schedulePoll(50);                                // still waiting — look again shortly
      return;
    }
    awaitingReply = true;
    sentAt = Date.now();
    try { ws.send(JSON.stringify({ id: 1, call: "eboards" })); } catch (e) { }
    schedulePoll(cur.pollMs);
  }
  function schedulePoll(ms) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(sendPoll, ms);
  }
  function stopPoll() {
    clearTimeout(pollTimer); pollTimer = null;
    awaitingReply = false;
  }
  let retryMs = 1000;
  const RETRY_CAP = 5000;

  // Currently applied connection params — apply() diffs against these.
  let cur = { effHost: undefined, serial: undefined, pollMs: undefined, demo: undefined };
  let LC_SERIAL = null, LC_LAST_W, LC_LAST_B;

  /* ---- picking up again after a dropout --------------------------------
     Three things have to happen when the feed comes back, and none of them
     used to:

     1. The BOARD has to be picked up even though the moves in between are
        unrecoverable. moves.js is told a gap happened, so the first position
        it cannot explain is adopted immediately instead of being held for the
        full resync window — across a dropout there is nothing to reconstruct
        and waiting only keeps a stale board on air.
     2. The CLOCKS have to be re-read. The DGT feed only changes a clock value
        at move-end, and we deliberately sync only on a change so the local
        countdown isn't reset every poll. After an outage that rule works
        against us: the real clocks ran while ours were frozen, and nothing
        would correct them until the next move completed. So the first message
        after a connect adopts the feed's values verbatim.
     3. A SILENT socket has to be noticed. A hung LiveChess or a dead network
        path that never sends a TCP reset leaves the socket "open" for ever:
        onclose never fires, so the old code would sit there reporting
        "connected" with a frozen board and no reconnect. A silence watchdog
        recycles the connection instead. */
  let hadConnection = false;             // we have been connected at least once
  let clockResyncPending = false;        // adopt the feed's clocks on the next message
  let lastMsgAt = 0;                     // last board message (epoch ms)

  /* ---- clock running + flagfall -----------------------------------------
     The per-second countdown is gated on the DGT feed's `clock.run`. On some
     boards/firmware that flag is never asserted, and then the display only
     jumped at each move-end sync instead of ticking — "the clock only counts
     down some of the time." So the gate ADAPTS: if this connection has ever
     seen run asserted, we trust it exactly as before (no change on hardware
     that reports it, incl. the test rig). If it has NEVER been asserted, we
     fall back to inferring from game state — the side to move's clock runs
     once the game is under way and until it is over. Pre-game is still quiet
     because game.started is false until the first move.

     Flagfall is FEED-AUTHORITATIVE: it fires only when the feed itself
     delivers a clock value of zero, never from the local countdown (which is
     a display estimate). Latched per side so it fires once, and re-armed when
     the feed shows that clock positive again (a new game or a clock reset).  */
  let sawRunTrue = false;
  const flagged = { w: false, b: false };
  // The side whose clock value changed at the LAST move-end sync. The player
  // who just pressed is NOT the one running — so the runner is the OTHER
  // side. This beats game.toMove, which is a guess after any mid-game
  // adoption (dropout, reload) and froze the thinking player's clock — the
  // venue saw black's clock stand still through whole thinks. Cleared when
  // it means nothing: fresh connection, new game, both values moving at once.
  let lastChangedSide = null;

  // Some LiveChess builds report run as a BOOLEAN, others as 0|1|2 (or
  // "white"/"black") NAMING the running side. Use the side when it's named.
  //
  // But a bare 1 is AMBIGUOUS, and reading it wrong is the whole black-clock
  // freeze: side-naming firmware means "white is running", while plenty of
  // boards send integer 1 for nothing more than "the clock is running". Taken
  // as "white" it names white on EVERY poll for the whole game, so the tick is
  // pinned to white — black's clock stands still through every think and
  // white's keeps running during them. So 1 only names white once this
  // connection has PROVED the board names sides by sending a 2 (no boolean is
  // ever 2). Until then 1 just means "running" and the side comes from the
  // last-press inference below, which is right either way. Strings name the
  // side unambiguously and are trusted immediately.
  let sawRunTwo = false;                 // this board has named BLACK at least once
  function runnerFromRun(r) {
    if (r === "white" || r === "w") return "w";
    if (r === "black" || r === "b") return "b";
    if (r === 2 || r === "2") { sawRunTwo = true; return "b"; }
    if (sawRunTwo && (r === 1 || r === "1")) return "w";
    return null;                         // boolean-style, an unproven 1, or absent
  }

  function noteFeedClock(side, s) {      // s: seconds from a real feed change
    if (s == null) return;
    if (s > 0) { flagged[side] = false; return; }
    if (flagged[side]) return;
    flagged[side] = true;                // feed says this clock has reached zero
    game.flagfall = { side, seq: (game.flagfall && game.flagfall.seq || 0) + 1 };
  }

  const diag = {
    reconnects: 0,                       // sockets opened after the first
    silentRecycles: 0,                   // connections dropped for going quiet
    lastMsgAgeMs: null,                  // null = nothing received yet
    silent: false,
  };

  function init(g) { game = g; }

  // host may be host-only (port appended) or "host:port" pasted whole.
  function effectiveHost(b) {
    let h = (b.manual_host_override && b.manual_host) ? String(b.manual_host).trim() : String(b.host || "").trim();
    if (!h) return null;
    if (!h.includes(":")) h = h + ":" + (Number(b.port) || 1982);
    return h;
  }

  function teardown() {
    stopPoll();
    clearTimeout(reconnectTimer); reconnectTimer = null;
    if (ws) {
      try { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; ws.close(); } catch (e) { }
      ws = null;
    }
    game.lcConnected = false;
    game.clockRunSide = null;                 // nothing ticks while disconnected
    // Force the next connection to re-read the clocks: ours are frozen at the
    // moment we lost the feed, and the real ones keep running.
    LC_LAST_W = undefined; LC_LAST_B = undefined;
    clockResyncPending = true;
    sawRunTrue = false;                        // re-learn this board's run semantics on reconnect
    sawRunTwo = false;
    lastChangedSide = null;
  }

  /* Silence watchdog. `ws` staying open is not proof the feed is alive, so a
     board message must arrive every few polls or the socket gets recycled. */
  function startMonitor() {
    clearInterval(monitorTimer);
    monitorTimer = setInterval(() => {
      diag.lastMsgAgeMs = lastMsgAt ? Date.now() - lastMsgAt : null;
      if (cur.demo || !cur.effHost || !ws || !game.lcConnected) { diag.silent = false; return; }
      const grace = Math.max(5000, (Number(cur.pollMs) || 800) * 5);
      if (lastMsgAt && Date.now() - lastMsgAt > grace) {
        diag.silent = true;
        diag.silentRecycles++;
        SCC.moves.noteFeedGap();              // whatever comes back, pick the board up
        teardown();
        retryMs = 1000;
        connect();
      } else {
        diag.silent = false;
      }
    }, 1000);
  }

  function scheduleReconnect() {
    if (cur.demo || !cur.effHost) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, retryMs);
    retryMs = Math.min(RETRY_CAP, retryMs * 2);      // 1s → 2s → 4s → 5s, never spins
  }

  function connect() {
    if (cur.demo || !cur.effHost) return;
    const url = "ws://" + cur.effHost + "/api/v1.0";
    try { ws = new WebSocket(url); } catch (e) { scheduleReconnect(); return; }
    ws.onopen = () => {
      retryMs = 1000;
      game.lcConnected = true;
      clockResyncPending = true;
      // Anything could have happened on the board while we were away, and the
      // moves in between are gone. Tell the engine so it adopts the position it
      // finds rather than holding a stale one.
      if (hadConnection) { diag.reconnects++; SCC.moves.noteFeedGap(); }
      hadConnection = true;
      lastMsgAt = Date.now();                 // start the silence clock from the open
      stopPoll();
      schedulePoll(0);                        // first request now; paced from here on
    };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      awaitingReply = false;                   // LiveChess answered — the next poll may go
      let boards = Array.isArray(msg.param) ? msg.param
        : (msg.param && msg.param.board ? [msg.param] : null);
      if (!boards) return;
      let b = cur.serial ? boards.find(x => String(x.serialnr) === String(cur.serial)) : null;
      if (!b) b = boards.find(x => x.state === "ACTIVE") || boards[0];
      if (!b) return;
      LC_SERIAL = b.serialnr || LC_SERIAL;
      // Raw placement straight from the feed, BEFORE the move engine filters it.
      // The scene auto-detector needs this: the DGT "result" signal (both kings
      // placed on the centre squares) is exactly the kind of unreachable
      // placement the move engine deliberately holds and hides.
      lastMsgAt = Date.now();
      if (b.board) {
        game.rawPlacement = String(b.board).split(" ")[0];
        // pieces back on the start squares = a new game: last move-end info
        // belongs to the previous one
        if (game.rawPlacement === SCC.moves.START_PLACEMENT) lastChangedSide = null;
        SCC.moves.applyPlacement(b.board, LC_SERIAL);
      }
      if (b.clock) {
        // First message after a connect: take the feed's clocks as they stand.
        // Done before the change-detection below so this doesn't count as a
        // move-end sync — per-move timing is left entirely alone.
        if (clockResyncPending) {
          clockResyncPending = false;
          const w0 = SCC.clock.lcClockSec(b.clock.white), b0 = SCC.clock.lcClockSec(b.clock.black);
          // adopt verbatim, and set the flag latch silently (no buzzer for a
          // clock that was already down when we reconnected)
          if (w0 != null) { game.white.sec = w0; LC_LAST_W = b.clock.white; flagged.w = w0 <= 0; }
          if (b0 != null) { game.black.sec = b0; LC_LAST_B = b.clock.black; flagged.b = b0 <= 0; }
          lastChangedSide = null;        // values re-read across a gap say nothing about who runs
        }
        // the feed only changes these at move-end; sync ONLY on a real change so the
        // local per-second countdown isn't reset back every poll. A real change is
        // also the only place flagfall is judged — see noteFeedClock.
        let wChanged = false, bChanged = false;
        if (b.clock.white !== LC_LAST_W) { LC_LAST_W = b.clock.white; const s = SCC.clock.lcClockSec(b.clock.white); if (s != null) { game.white.sec = s; SCC.moves.syncClock("w", s); noteFeedClock("w", s); wChanged = true; } }
        if (b.clock.black !== LC_LAST_B) { LC_LAST_B = b.clock.black; const s = SCC.clock.lcClockSec(b.clock.black); if (s != null) { game.black.sec = s; SCC.moves.syncClock("b", s); noteFeedClock("b", s); bChanged = true; } }
        if (wChanged && bChanged) lastChangedSide = null;      // both moved: adjust/reset, no side info
        else if (wChanged) lastChangedSide = "w";
        else if (bChanged) lastChangedSide = "b";
        // WHICH clock ticks — from the best signal the feed gives, in order:
        //  1. run NAMES the side (0|1|2 / "white"/"black" firmware) → that side.
        //  2. run is boolean-true → the OPPOSITE of the last side whose value
        //     changed: whoever just pressed isn't running. Immune to a wrong
        //     game.toMove after an adopted position (the black-freeze bug).
        //  3. no change seen yet this connection → game.toMove.
        // A board that never asserts run at all falls back to inference from
        // game state (started, not over), same side resolution.
        if (b.clock.run) sawRunTrue = true;
        const believedRunning = sawRunTrue
          ? !!b.clock.run
          : (game.started && !SCC.moves.gameStatus().over);
        const named = runnerFromRun(b.clock.run);
        game.clockRunSide = !believedRunning ? null
          : named ? named
          : lastChangedSide ? (lastChangedSide === "w" ? "b" : "w")
          : game.toMove;
        diag.clock = {
          w: b.clock.white, b: b.clock.black,
          run: b.clock.run === undefined ? null : b.clock.run,
          run_type: typeof b.clock.run,
          saw_run: sawRunTrue, names_sides: sawRunTwo, last_changed: lastChangedSide,
          side: game.clockRunSide,
        };
      }
    };
    ws.onclose = () => {
      stopPoll();
      game.lcConnected = false;
      game.clockRunSide = null;
      ws = null;
      scheduleReconnect();
    };
    ws.onerror = () => { try { ws.close(); } catch (e) { } };
  }

  function applyDemo() {
    teardown();
    game.demo = true;
    game.fen = DEMO.fen;
    game.lastMove = { ...DEMO.lastMove };
    game.toMove = DEMO.toMove;
    game.moves = DEMO.moves.slice();
    game.currentPly = DEMO.currentPly;
    game.white.sec = SCC.clock.parseClock(DEMO.white.clock);
    game.black.sec = SCC.clock.parseClock(DEMO.black.clock);
    game.clockRunSide = null;                 // demo clocks hold, exactly as the original demo did
    game.started = false;
  }

  function clearDemo() {
    game.demo = false;
    SCC.moves.reset();                        // back to the empty pre-connection board
    game.white.sec = null;
    game.black.sec = null;
  }

  // Called on boot and whenever config changes. cfgBoard = config board.json.
  function apply(cfgBoard) {
    const effHost = effectiveHost(cfgBoard);
    const serial = cfgBoard.serialnr != null && cfgBoard.serialnr !== "" ? String(cfgBoard.serialnr) : "";
    const pollMs = Math.max(200, Number(cfgBoard.poll_ms) || 300);
    const demo = !!cfgBoard.demo_mode;

    const first = cur.effHost === undefined;
    const hostChanged = !first && effHost !== cur.effHost;
    const serialChanged = !first && serial !== cur.serial;
    const pollChanged = !first && pollMs !== cur.pollMs;
    const demoChanged = !first && demo !== cur.demo;

    // Unrelated config writes must never restart the connection or reset moves.
    if (!first && !hostChanged && !serialChanged && !pollChanged && !demoChanged) return;

    cur = { effHost, serial, pollMs, demo };

    if (demo) { applyDemo(); return; }
    if (demoChanged) clearDemo();             // leaving demo → clean empty board

    if (serialChanged) SCC.moves.reset();     // different physical board = different game

    if (first || hostChanged || serialChanged || demoChanged) {
      teardown();
      retryMs = 1000;
      startMonitor();
      connect();
      return;
    }
    if (pollChanged && ws) {                  // poll cadence change alone: no reconnect
      schedulePoll(cur.pollMs);               // the paced loop picks up cur.pollMs
    }
  }

  return { init, apply, diag, DEMO };
})();
