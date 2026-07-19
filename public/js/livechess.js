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

  let ws = null, pollTimer = null, reconnectTimer = null;
  let retryMs = 1000;
  const RETRY_CAP = 5000;

  // Currently applied connection params — apply() diffs against these.
  let cur = { effHost: undefined, serial: undefined, pollMs: undefined, demo: undefined };
  let LC_SERIAL = null, LC_LAST_W, LC_LAST_B;

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
      if (b.board) { game.rawPlacement = String(b.board).split(" ")[0]; SCC.moves.applyPlacement(b.board); }
      if (b.clock) {
        // the feed only changes these at move-end; sync ONLY on a real change so the
        // local per-second countdown isn't reset back every poll.
        if (b.clock.white !== LC_LAST_W) { LC_LAST_W = b.clock.white; const s = SCC.clock.lcClockSec(b.clock.white); if (s != null) game.white.sec = s; }
        if (b.clock.black !== LC_LAST_B) { LC_LAST_B = b.clock.black; const s = SCC.clock.lcClockSec(b.clock.black); if (s != null) game.black.sec = s; }
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
      connect();
      return;
    }
    if (pollChanged && ws && pollTimer) {     // poll cadence change alone: no reconnect
      clearInterval(pollTimer);
      pollTimer = setInterval(() => { try { ws.send(JSON.stringify({ id: 1, call: "eboards" })); } catch (e) { } }, cur.pollMs);
    }
  }

  return { init, apply, DEMO };
})();
