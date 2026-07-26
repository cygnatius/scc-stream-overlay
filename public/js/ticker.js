/* =========================================================================
   ticker.js — the commentary tickertape.

   The operator types messages in admin; each one rolls across the bottom of
   the canvas in turn and the list loops. One message is on screen at a time,
   which is what makes the two apply modes honest:

     GRACEFUL (default) — a save bumps ticker.generation. The display finishes
       the message currently rolling, then picks up the new list at the cycle
       boundary. Nothing on air ever jumps: an edited, added or deleted
       message simply takes effect from the next message onward.
     FORCEFUL — a save bumps ticker.force_token. The display abandons whatever
       is rolling and restarts from the top of the new list immediately. For
       when the wrong thing is on screen and it has to go NOW.

   Create, update and delete all travel through the same two doors, so
   "delete that message gracefully" and "kill that message now" are both
   one click.

   Motion is a single GPU-composited transform per message (start pose, then
   one transition to the end pose — the same two-step used by the scene
   transitions), not a per-frame rAF loop: OBS composites it smoothly and it
   costs nothing on the main thread while a game is being tracked. A safety
   timer advances the queue if transitionend never arrives (hidden tabs
   throttle transitions), so the ticker can never wedge.

   Classic script; exposes window.SCC.ticker. Requires vue.global.js, config.js.
   ========================================================================= */
"use strict";
window.SCC = window.SCC || {};

SCC.ticker = (function () {
  const STAGE_W = 1920;                  // fixed canvas width — see display.html
  const MIN_SPEED = 20, MAX_SPEED = 400; // px/s guard rails

  let cfg = null;                        // SCC.config.store

  const view = Vue.reactive({
    text: "",                            // message currently rolling
    key: 0,                              // bumped per message — re-keys the element
    phase: "idle",                       // idle | pose | rolling
    x: STAGE_W,                          // current transform target (px)
    durMs: 0,
    showing: false,                       // any active messages at all
  });

  let queue = [];                        // active message texts, in order
  let idx = 0;
  let appliedGeneration = null;
  let appliedForce = null;
  let safety = null;

  // The rolling element is re-created per message (:key) and lives in whichever
  // mount the current scene uses, so it is looked up fresh rather than held.
  const node = () => document.querySelector(".tk-item");

  function tcfg() { return (cfg && cfg.data && cfg.data.ticker) || {}; }

  function buildQueue() {
    const t = tcfg();
    return (Array.isArray(t.messages) ? t.messages : [])
      .filter(m => m && m.active !== false && String(m.text || "").trim())
      .map(m => String(m.text).trim());
  }

  function speed() {
    const s = Number(tcfg().speed_px_s);
    return Math.min(MAX_SPEED, Math.max(MIN_SPEED, s || 90));
  }

  function stop() {
    clearTimeout(safety); safety = null;
    view.phase = "idle"; view.showing = false; view.text = ""; view.durMs = 0; view.x = STAGE_W;
  }

  /* ---------------------------------------------------------- one message */

  function roll(text) {
    view.text = text;
    view.key++;
    view.showing = true;
    view.phase = "pose";                 // start pose: off the right edge, no transition
    view.x = STAGE_W;
    view.durMs = 0;

    Vue.nextTick(() => {
      // Measure the rendered text, then animate the whole way across.
      const el = node();
      const w = el ? el.offsetWidth : 400;
      if (view.phase !== "pose") return;             // superseded (forceful apply)
      if (el) void el.offsetWidth;                   // commit the start pose
      const distance = STAGE_W + w;
      view.durMs = Math.round((distance / speed()) * 1000);
      view.x = -w;
      view.phase = "rolling";
      clearTimeout(safety);
      safety = setTimeout(next, view.durMs + 750);   // never wedge if transitionend is lost
    });
  }

  // Called on transitionend and by the safety timer.
  function next() {
    clearTimeout(safety); safety = null;
    if (view.phase !== "rolling") return;
    idx++;
    // A graceful save lands here, between messages.
    const t = tcfg();
    if (t.generation !== appliedGeneration) { appliedGeneration = t.generation; queue = buildQueue(); idx = 0; }
    if (idx >= queue.length) {
      queue = buildQueue();                          // re-read: nothing changes mid-loop otherwise
      idx = 0;
    }
    if (!enabledNow() || !queue.length) { stop(); return; }
    roll(queue[idx]);
  }

  function enabledNow() {
    const t = tcfg();
    if (!t.enabled) return false;
    const scene = window.SCC.scenes ? SCC.scenes.view.current : "game";
    const on = t.show_on || {};
    return on[scene] !== false;
  }

  /* --------------------------------------------------------- config driver */

  function sync() {
    const t = tcfg();
    const fresh = buildQueue();

    // FORCEFUL: restart from the top of the new list right now.
    if (appliedForce !== null && t.force_token !== appliedForce) {
      appliedForce = t.force_token;
      appliedGeneration = t.generation;
      queue = fresh; idx = 0;
      clearTimeout(safety); safety = null;
      if (enabledNow() && queue.length) roll(queue[0]); else stop();
      return;
    }
    if (appliedForce === null) appliedForce = t.force_token;
    if (appliedGeneration === null) appliedGeneration = t.generation;

    // Turned off, or every message deleted/deactivated: leave the air cleanly
    // at the end of the current message (the graceful path handles it), but if
    // nothing is rolling right now, just stay dark.
    if (!enabledNow() || !fresh.length) {
      if (view.phase === "idle") stop();
      return;
    }
    // Nothing rolling and we have messages → start.
    if (view.phase === "idle") {
      queue = fresh; idx = 0; appliedGeneration = t.generation;
      roll(queue[0]);
    }
  }

  /* ------------------------------------------------------------------ api */

  function onEnd() { next(); }

  // Inline style for the rolling element.
  function itemStyle() {
    return {
      transform: "translateX(" + view.x + "px)",
      transition: view.phase === "rolling" ? "transform " + view.durMs + "ms linear" : "none",
    };
  }

  function init(configStore) {
    cfg = configStore;
    SCC.config.onChange(() => sync());
    if (window.SCC.scenes) SCC.scenes.onSceneChange(() => {
      // Scene changed: start or stop without waiting for a config write.
      if (!enabledNow()) { if (view.phase !== "idle") stop(); }
      else if (view.phase === "idle") sync();
    });
    if (cfg.loaded) sync();
  }

  return { init, view, onEnd, itemStyle, enabledNow };
})();
