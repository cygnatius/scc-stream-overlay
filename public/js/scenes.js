/* =========================================================================
   scenes.js — the six-scene system.

   ONE SOURCE OF TRUTH: config/scenes.json. Every scene command — manual
   switch, sequence start, automatic proposal, cancel — is a write to that
   file, and the display renders deterministically from it. That is what
   makes admin and display agree, and what lets a reloaded display resume
   mid-sequence (phases are computed from sequence.started_at, not from
   local timers).

   WRITER DISCIPLINE (single-operator, localhost):
     admin writes:    active scene, sequence starts, cancels, settings
     display writes:  pending_auto proposals (the detector), the execution
                      of a pending action when its arm delay elapses, the
                      finalisation of a completed sequence, and clearing a
                      pending action when detector confidence degrades.

   AUTO-DETECTION: edge-triggered, confidence-gated, and always cancellable.
   A proposal is only a pending_auto entry with a fires_at a few seconds out;
   admin shows the countdown and can clear it before it fires. A board
   disconnect, demo mode, or an untracked game degrades confidence to
   "unknown" and both suppresses new proposals and withdraws a live one.
   Cancelled edges are remembered so the same event never re-proposes.

   Classic script; exposes window.SCC.scenes. Requires vue.global.js,
   config.js, moves.js.
   ========================================================================= */
"use strict";
window.SCC = window.SCC || {};

SCC.scenes = (function () {
  const SCENES = ["start", "versus", "game", "postgame", "intermission", "ending"];
  const CENTRE = new Set(["d4", "e4", "d5", "e5"]);

  let game = null;
  let cfg = null;                 // SCC.config.store
  const sceneListeners = [];      // fn(entering, leaving) — e.g. intermission video control

  /* Reactive view consumed by display.html — which layers show, and how. */
  const view = Vue.reactive({
    current: "game",              // the scene occupying the canvas (transition target once begun)
    leaving: null,                // scene animating out (crossfade/slide/wipe), else null
    phase: "idle",                // idle | delay | pre | animating | fade-out | fade-in
    type: "cut",
    durMs: 0,
    direction: "left",
    curtainOn: false,             // fade-through-black overlay state
    curtainMs: 0,
    confidence: "unknown",        // good | unknown  (detector gate)
    detected: "no game",          // human-readable detector state (admin display)
    pendingAuto: null,            // mirror of scenes.pending_auto
    seqName: null,                // running sequence name (admin display)
  });

  /* ------------------------------------------------------------ helpers */

  function num(...vals) { for (const v of vals) { const n = Number(v); if (v != null && !Number.isNaN(n)) return n; } return 0; }

  function effectiveScene(sc, now) {
    const seq = sc.sequence;
    if (seq && seq.name && seq.started_at) {
      const el = now - seq.started_at;
      const t = (sc.sequences && sc.sequences[seq.name]) || {};
      if (seq.name === "game_start") {
        if (el < num(t.versus_ms, 8000)) return { scene: "versus", done: false };
        return { scene: "game", done: true };
      }
      if (seq.name === "game_end") {
        const p = num(t.postgame_ms, 40000), s = num(t.start_ms, 150000);
        if (el < p) return { scene: "postgame", done: false };
        if (el < p + s) return { scene: "start", done: false };
        return { scene: "intermission", done: true };
      }
    }
    return { scene: SCENES.includes(sc.active) ? sc.active : "game", done: false };
  }

  // Per-scene enter transition ⊕ per-type defaults ⊕ global default.
  function resolveTransition(sc, toScene) {
    const ov = ((sc.scenes && sc.scenes[toScene]) || {}).transition || {};
    const def = sc.default_transition || {};
    const type = ov.type || def.type || "fade";
    const typeDef = (sc.transitions && sc.transitions[type]) || {};
    return {
      type: ["cut", "fade", "crossfade", "slide", "wipe"].includes(type) ? type : "fade",
      duration_ms: Math.max(0, num(ov.duration_ms, typeDef.duration_ms, def.duration_ms, 1000)),
      delay_ms: Math.max(0, num(ov.delay_ms, typeDef.delay_ms, def.delay_ms, 0)),
      direction: ov.direction || typeDef.direction || def.direction || "left",
    };
  }

  /* --------------------------------------------------- config writes */

  // Full-file replace with an optimistic local apply, so the display acts on
  // its own writes immediately instead of waiting a poll interval.
  async function writeScenes(patch) {
    const merged = JSON.parse(JSON.stringify(cfg.data.scenes));
    Object.assign(merged, patch);
    cfg.data.scenes = merged;
    try {
      await fetch("/api/config/scenes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(merged),
      });
    } catch (e) { /* server down: local state still advanced; poll reconciles later */ }
  }

  /* ----------------------------------------------------- transitions */

  let transTimers = [];
  function clearTransTimers() { transTimers.forEach(clearTimeout); transTimers = []; }
  function after(ms, fn) { transTimers.push(setTimeout(fn, ms)); }

  function playTransition(to, tcfg, immediate) {
    const from = view.current;
    clearTransTimers();
    view.leaving = null;

    const begin = () => {
      view.type = tcfg.type; view.durMs = tcfg.duration_ms; view.direction = tcfg.direction;
      // Hidden pages (a backgrounded preview tab) pause rAF and throttle
      // timers, so an animated transition would stall or show a half-state
      // when re-fronted — cut instead. OBS renders its browser sources as
      // visible, so on stream this branch never triggers.
      // (window.SCC_FORCE_ANIM is a test hook: lets automated checks drive
      // the animation state machine in a hidden pane.)
      const hidden = document.hidden && !window.SCC_FORCE_ANIM;
      if (immediate || hidden || tcfg.type === "cut" || tcfg.duration_ms === 0) {
        switchTo(to, from); view.phase = "idle"; view.curtainOn = false;
        return;
      }
      if (tcfg.type === "fade") {                    // fade through black: out, swap, in
        view.curtainMs = tcfg.duration_ms / 2;
        view.phase = "fade-out"; view.curtainOn = true;
        after(tcfg.duration_ms / 2, () => {
          switchTo(to, from);
          view.phase = "fade-in"; view.curtainOn = false;
          after(tcfg.duration_ms / 2, () => { view.phase = "idle"; });
        });
        return;
      }
      // crossfade / slide / wipe — both layers live; two-step pose so CSS
      // transitions animate from the start pose. The pose step is microtask-
      // based (Vue nextTick + a forced reflow), NOT requestAnimationFrame —
      // rAF never fires in hidden pages, which would freeze the state machine.
      switchTo(to, from);
      view.leaving = from;
      view.phase = "pre";
      Vue.nextTick(() => {
        const el = document.querySelector(".sc-" + to);
        if (el) void el.offsetWidth;                 // commit the start pose before animating
        if (view.phase !== "pre") return;            // superseded mid-flight
        view.phase = "animating";
        after(tcfg.duration_ms, () => { view.leaving = null; view.phase = "idle"; });
      });
    };

    if (tcfg.delay_ms > 0 && !immediate) { view.phase = "delay"; after(tcfg.delay_ms, begin); }
    else begin();
  }

  function switchTo(to, from) {
    view.current = to;
    for (const fn of sceneListeners) { try { fn(to, from); } catch (e) { console.warn("[scenes] listener failed:", e); } }
  }

  // Inline style for a scene layer — consumed by the display template.
  // Reading reactive `view` inside the render keeps it live.
  function layerState(name) {
    const s = { position: "absolute", inset: "0" };
    const dir = view.direction;
    const slideOff = (d) => d === "left" ? "translateX(100%)" : d === "right" ? "translateX(-100%)"
      : d === "up" ? "translateY(100%)" : "translateY(-100%)";
    const slideOut = (d) => d === "left" ? "translateX(-30%)" : d === "right" ? "translateX(30%)"
      : d === "up" ? "translateY(-30%)" : "translateY(30%)";
    const wipeClip = (d) => d === "left" ? "inset(0 100% 0 0)" : d === "right" ? "inset(0 0 0 100%)"
      : d === "up" ? "inset(100% 0 0 0)" : "inset(0 0 100% 0)";

    if (name === view.current) {
      s.zIndex = 2;
      if (view.phase === "pre") {
        s.transition = "none";
        if (view.type === "crossfade") s.opacity = 0;
        if (view.type === "slide") s.transform = slideOff(dir);
        if (view.type === "wipe") s.clipPath = wipeClip(dir);
      } else if (view.phase === "animating") {
        s.transition = `opacity ${view.durMs}ms ease, transform ${view.durMs}ms cubic-bezier(.4,0,.2,1), clip-path ${view.durMs}ms cubic-bezier(.4,0,.2,1)`;
        s.opacity = 1; s.transform = "none";
        if (view.type === "wipe") s.clipPath = "inset(0 0 0 0)";
      }
      return s;
    }
    if (name === view.leaving) {
      s.zIndex = 1;
      if (view.phase === "pre") { s.transition = "none"; }
      else if (view.phase === "animating") {
        s.transition = `opacity ${view.durMs}ms ease, transform ${view.durMs}ms cubic-bezier(.4,0,.2,1)`;
        if (view.type === "crossfade") s.opacity = 0;
        if (view.type === "slide") { s.transform = slideOut(dir); }
        // wipe: the old scene sits still and is revealed over
      }
      return s;
    }
    s.visibility = "hidden";
    s.pointerEvents = "none";
    return s;
  }

  /* -------------------------------------------------------- detector */

  // The game-start edge is LATCHED by a watcher (see init), not sampled by
  // the tick: a watcher fires on every reactive change, so a reset→first-move
  // window can never fall invisibly between two detector passes, no matter
  // how coarse the tick cadence gets (throttled tabs).
  let gameId = 0;
  let startEdge = false;
  let startProposedFor = -1;
  let endProposedKeys = new Set();
  let executedAt = 0;
  let finalizedSeqAt = 0;
  let bootStaleChecked = false;

  function isKingsCentreSignal(raw) {
    if (!raw || !game) return false;
    // The DGT result convention: the players place both kings on the four
    // centre squares. That arrangement is (as good as) never a position the
    // tracked game can reach, so require the raw feed to disagree with the
    // reconstructed position — a legal Ke4/Ke5 mid-game never triggers this.
    if (!game.fen || raw === String(game.fen).split(" ")[0]) return false;
    const files = "abcdefgh";
    let wk = null, bk = null, i = 0;
    for (const row of raw.split("/")) {
      for (const ch of row) {
        if (/\d/.test(ch)) { i += Number(ch); continue; }
        const sq = files[i % 8] + (8 - Math.floor(i / 8));
        if (ch === "K") wk = sq; if (ch === "k") bk = sq;
        i++;
      }
    }
    return !!(wk && bk && CENTRE.has(wk) && CENTRE.has(bk));
  }

  function runDetector(sc, now) {
    const st = SCC.moves.gameStatus();
    const conf = (!game.lcConnected || game.demo || !st.tracking) ? "unknown" : "good";
    view.confidence = conf;

    const startedEdge = startEdge;
    startEdge = false;                       // consume the latch

    const over = st.tracking && st.over && game.moves.length > 0;
    const kingsCentre = isKingsCentreSignal(game.rawPlacement);
    view.detected = over
      ? (st.checkmate ? "game over — checkmate" : st.stalemate ? "game over — stalemate" : "game over — draw")
      : kingsCentre ? "result signal — kings on centre squares"
        : game.started ? "game in progress"
          : game.demo ? "demo mode" : "no game";

    // Degraded confidence: suppress proposals AND withdraw a live one.
    // (A disconnect must never be allowed to fire a queued transition.)
    if (conf !== "good") {
      if (sc.pending_auto) writeScenes({ pending_auto: null });
      return;
    }
    const auto = sc.auto || {};
    if (!auto.enabled) return;
    const arm = Math.max(1000, num(auto.arm_delay_ms, 4000));

    if (startedEdge && !sc.sequence && !sc.pending_auto
      && view.current !== "game" && view.current !== "versus"
      && startProposedFor !== gameId) {
      startProposedFor = gameId;
      writeScenes({ pending_auto: { action: "game_start", fires_at: now + arm, reason: "first move played on the board" } });
      return;
    }

    const endKey = over ? "over:" + game.fen : kingsCentre ? "kc:" + game.rawPlacement : null;
    if (endKey && !sc.sequence && !sc.pending_auto
      && view.current === "game" && !endProposedKeys.has(endKey)) {
      endProposedKeys.add(endKey);
      const reason = over ? "game finished on the board (" + view.detected.replace("game over — ", "") + ")"
        : "kings placed on the centre squares (result signal)";
      writeScenes({ pending_auto: { action: "game_end", fires_at: now + arm, reason } });
    }
  }

  /* ------------------------------------------------------- main tick */

  let targetScene = null;
  let firstSync = true;

  function tick() {
    if (!cfg.loaded) return;
    const sc = cfg.data.scenes;
    const now = Date.now();

    // A pending action left over from before a display restart is stale —
    // never fire a transition the operator queued for a different moment.
    if (!bootStaleChecked) {
      bootStaleChecked = true;
      if (sc.pending_auto && num(sc.pending_auto.fires_at) < now - 10000) writeScenes({ pending_auto: null });
    }

    // 1. effective scene → transitions
    const eff = effectiveScene(sc, now);
    view.seqName = sc.sequence ? sc.sequence.name : null;
    if (eff.scene !== targetScene) {
      targetScene = eff.scene;
      playTransition(eff.scene, resolveTransition(sc, eff.scene), firstSync);
    }
    firstSync = false;

    // 2. finalise a completed sequence (write once per sequence instance)
    if (sc.sequence && eff.done && finalizedSeqAt !== sc.sequence.started_at) {
      finalizedSeqAt = sc.sequence.started_at;
      writeScenes({ active: eff.scene, sequence: null });
    }

    // 3. fire a pending automatic action whose arm delay has elapsed
    const p = sc.pending_auto;
    if (p && num(p.fires_at) <= now && executedAt !== p.fires_at) {
      executedAt = p.fires_at;
      if (p.action === "game_start") writeScenes({ sequence: { name: "game_start", started_at: now }, pending_auto: null });
      else if (p.action === "game_end") writeScenes({ sequence: { name: "game_end", started_at: now }, pending_auto: null });
      else writeScenes({ pending_auto: null });
    }
    view.pendingAuto = sc.pending_auto;

    // 4. detector
    runDetector(sc, now);
  }

  /* ------------------------------------------------- status heartbeat */

  async function postStatus() {
    try {
      await fetch("/api/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          at: Date.now(),
          scene: view.current,
          sequence: view.seqName,
          confidence: view.confidence,
          detected: view.detected,
          pending_auto: view.pendingAuto,
          lc_connected: game.lcConnected,
          demo: game.demo,
          moves: game.moves.length,
          config_hash: cfg.hash,
          config_ok: cfg.ok,
          pgn: window.SCC.pgn ? { status: SCC.pgn.state.status, source: SCC.pgn.state.source } : null,
          pairingsman: window.SCC.pairingsman
            ? { status: SCC.pairingsman.state.status, entity: SCC.pairingsman.state.entity, fetched_at: SCC.pairingsman.state.fetchedAt }
            : null,
        }),
      });
    } catch (e) { /* server down — heartbeat resumes when it returns */ }
  }

  /* ------------------------------------------------------------ init */

  function init(g, configStore) {
    game = g;
    cfg = configStore;
    // Event-latch the game-start edge (false→true on game.started). Fires per
    // change regardless of tick cadence — see the detector note above.
    // A new game also clears the end-detection dedupe keys: a cancelled result
    // signal in one game must not suppress the identical signal next game
    // (the kings-centre placement is the same raw string every time).
    Vue.watch(() => game.started, (n, o) => {
      if (n && !o) { gameId++; startEdge = true; endProposedKeys.clear(); }
    });
    setInterval(tick, 250);
    setInterval(postStatus, 1000);
  }

  function onSceneChange(fn) { sceneListeners.push(fn); }

  // Test hook: run one engine pass synchronously. Background tabs throttle
  // timers to the point of stalling automated checks; production behaviour
  // (OBS renders sources as visible) is unaffected and never calls this.
  function __pump() { tick(); return postStatus(); }

  return { init, view, layerState, onSceneChange, SCENES, __pump };
})();
