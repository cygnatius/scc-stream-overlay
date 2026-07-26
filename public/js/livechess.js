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
    clearInterval(pollTimer); pollTimer = null;
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
      clearInterval(pollTimer);
      pollTimer = setInterval(() => { try { ws.send(JSON.stringify({ id: 1, call: "eboards" })); } catch (e) { } }, cur.pollMs);
    };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
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
      if (b.board) { game.rawPlacement = String(b.board).split(" ")[0]; SCC.moves.applyPlacement(b.board, LC_SERIAL); }
      if (b.clock) {
        // First message after a connect: take the feed's clocks as they stand.
        // Done before the change-detection below so this doesn't count as a
        // move-end sync — per-move timing is left entirely alone.
        if (clockResyncPending) {
          clockResyncPending = false;
          const w0 = SCC.clock.lcClockSec(b.clock.white), b0 = SCC.clock.lcClockSec(b.clock.black);
          if (w0 != null) { game.white.sec = w0; LC_LAST_W = b.clock.white; }
          if (b0 != null) { game.black.sec = b0; LC_LAST_B = b.clock.black; }
        }
        // the feed only changes these at move-end; sync ONLY on a real change so the
        // local per-second countdown isn't reset back every poll.
        if (b.clock.white !== LC_LAST_W) { LC_LAST_W = b.clock.white; const s = SCC.clock.lcClockSec(b.clock.white); if (s != null) { game.white.sec = s; SCC.moves.syncClock("w", s); } }
        if (b.clock.black !== LC_LAST_B) { LC_LAST_B = b.clock.black; const s = SCC.clock.lcClockSec(b.clock.black); if (s != null) { game.black.sec = s; SCC.moves.syncClock("b", s); } }
        // Only tick a clock while the DGT feed says one is running — this is what stops the
        // pre-game countdown. `clock.run` is a BOOLEAN: true while a clock is running, null/
        // false when both are stopped (before the game starts and while it's paused). It does
        // not name a side, so the running clock is simply the side to move. (The feed's white/
        // black values hold steady between moves — confirmed live — so we tick locally and
        // re-sync to the feed only when it changes, at move-end, above.)
        game.clockRunSide = b.clock.run ? game.toMove : null;
      }
    };
    ws.onclose = () => {
      clearInterval(pollTimer); pollTimer = null;
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
    const pollMs = Math.max(200, Number(cfgBoard.poll_ms) || 800);
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
    if (pollChanged && ws && pollTimer) {     // poll cadence change alone: no reconnect
      clearInterval(pollTimer);
      pollTimer = setInterval(() => { try { ws.send(JSON.stringify({ id: 1, call: "eboards" })); } catch (e) { } }, cur.pollMs);
    }
  }

  return { init, apply, diag, DEMO };
})();
