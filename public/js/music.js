/* =========================================================================
   music.js — looping background-music bed for the broadcast.

   OBS hears this because the browser source's own audio goes straight into
   the OBS mixer ("Control audio via OBS" on the source) — nothing plays out
   of the venue speakers and no microphone is involved.

   Config-driven like everything else: admin writes config/music.json, the
   display reacts within a poll tick. Admin "buttons" that need to poke the
   display (Next track, Reshuffle) ride the same file as counters — this
   module consumes counter CHANGES, so a display reload never replays them.

   SHUFFLE CONTRACT (the whole point): shuffle is ONE seeded order, looped
   in full — never a per-track random pick, so nothing repeats until the
   entire library has played. Each track's sort key is hash(seed|filename):
   the order is stable across reloads, and adding/removing a track splices
   it in/out without reshuffling the rest. Reshuffle = admin bumps the seed.

   Quiet on air by design: autoplay refusal (a normal browser tab; OBS allows
   autoplay) is reported to admin via the heartbeat and retried on the first
   click/keypress — no visible element ever appears on the display.

   `?music=0` on the display URL makes this module inert — for any second
   display instance in OBS, so the bed is never doubled into the mix.

   Classic script; exposes window.SCC.music. Requires config.js, scenes.js.
   ========================================================================= */
"use strict";
window.SCC = window.SCC || {};

SCC.music = (function () {
  const LS_KEY = "scc.music.last";      // { file } — survive display reloads mid-playlist

  let cfg = null;                       // SCC.config.store
  let el = null;                        // the (never-attached-to-layout) <audio>
  let inert = false;                    // ?music=0

  let order = [];                       // filenames in play order
  let current = "";                     // filename loaded in el
  let state = "off";                    // off | playing | paused | blocked | error
  let blocked = false;                  // autoplay refused; a gesture retries
  let errorStreak = 0;                  // consecutive unplayable tracks
  let lastSkip = null;                  // consumed skip_count (null until first config)
  let lastSeed = null;
  let lastOrderKey = "";                // library composition marker (clears error give-up)
  let baseVol = 0.5;
  let fadeMs = 800;
  const fade = { timer: null, factor: 0, target: 0 };  // factor 0..1 multiplies baseVol; 0 at boot → first start fades in

  /* ------------------------------------------------------------ helpers */

  function fnv(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h;
  }

  function computeOrder(m) {
    const files = (Array.isArray(m.tracks) ? m.tracks : [])
      .filter(t => t && t.file && t.enabled !== false)
      .map(t => String(t.file));
    if (!m.shuffle) return files;                    // list order as saved
    const seed = String(m.shuffle_seed == null ? 1 : m.shuffle_seed);
    return files.slice().sort((a, b) => {
      const ka = fnv(seed + "|" + a), kb = fnv(seed + "|" + b);
      return ka - kb || (a < b ? -1 : a > b ? 1 : 0);
    });
  }

  function applyVolume() {
    if (el) el.volume = Math.max(0, Math.min(1, baseVol * fade.factor));
  }

  // Fade the FACTOR, not the config volume, so a slider change lands
  // instantly at any point of a fade. Hidden tabs throttle the interval —
  // the fade just stretches; OBS renders its sources visible.
  function fadeTo(target, done) {
    clearInterval(fade.timer);
    fade.timer = null;
    fade.target = target;                          // reconcile steers by this, so an in-flight
    const from = fade.factor;                      // fade-to-pause can always be overruled
    if (fadeMs <= 0 || from === target) {
      fade.factor = target;
      applyVolume();
      if (done) done();
      return;
    }
    const t0 = Date.now();
    fade.timer = setInterval(() => {
      const k = Math.min(1, (Date.now() - t0) / fadeMs);
      fade.factor = from + (target - from) * k;
      applyVolume();
      if (k >= 1) { clearInterval(fade.timer); fade.timer = null; if (done) done(); }
    }, 50);
  }

  /* --------------------------------------------------------- scene duck */

  // Music yields to the intermission video's own sound. A muted video or
  // the branded "Back shortly" card (no video) keeps the bed running.
  function duckedByScene() {
    const m = cfg.data.music || {};
    if (m.pause_in_intermission === false) return false;
    if (SCC.scenes.view.current !== "intermission") return false;
    const iv = ((cfg.data.scenes.scenes || {}).intermission) || {};
    return !!iv.video && !iv.muted;
  }

  /* ----------------------------------------------------------- playback */

  function loadTrack(file) {
    current = file;
    try { localStorage.setItem(LS_KEY, JSON.stringify({ file })); } catch (e) { }
    el.loop = order.length === 1;                  // a one-track library loops gaplessly
    el.src = "/assets/music/" + encodeURIComponent(file);
    el.load();
  }

  function startPlayback() {
    if (!el.src) return;
    state = "playing";                             // optimistic; catch corrects
    const p = el.play();
    if (p && p.catch) p.catch((e) => {
      const name = e && e.name;
      if (name === "NotAllowedError") {            // autoplay policy (normal browser tab)
        blocked = true;
        state = "blocked";
        armUnlock();
      } else if (name !== "AbortError") {          // AbortError = superseded by a newer load
        onError();                                 // e.g. unplayable file — same path as the element event
      }
    });
    if (fade.factor < 1 || fade.target !== 1) fadeTo(1);
  }

  function nextTrack() {
    if (!order.length) return;
    const i = order.indexOf(current);              // -1 → starts at 0
    loadTrack(order[(i + 1) % order.length]);
    startPlayback();
  }

  let unlockArmed = false;
  function armUnlock() {
    if (unlockArmed) return;
    unlockArmed = true;
    const h = () => {
      window.removeEventListener("pointerdown", h);
      window.removeEventListener("keydown", h);
      unlockArmed = false;
      reconcile();
    };
    window.addEventListener("pointerdown", h);
    window.addEventListener("keydown", h);
  }

  /* ---------------------------------------------------------- reconcile
     One idempotent pass from config + scene to player state. Runs on every
     config apply and scene change, so it must never restart a track that is
     already the right one.                                                 */

  function reconcile() {
    if (inert || !cfg.loaded) return;
    const m = cfg.data.music || {};
    baseVol = Math.max(0, Math.min(1, (Number(m.volume) || 0) / 100));
    fadeMs = Math.max(0, Number(m.fade_ms) || 0);
    order = computeOrder(m);
    applyVolume();

    // Admin nudges arrive as counter bumps; consume changes only, so a
    // reload (or the very first config) never acts on a stale counter.
    const skip = Number(m.skip_count) || 0;
    const seed = Number(m.shuffle_seed) || 0;
    let advance = false;
    if (lastSkip === null) { lastSkip = skip; lastSeed = seed; }
    else {
      if (skip !== lastSkip) { lastSkip = skip; advance = true; }
      if (seed !== lastSeed) { lastSeed = seed; }  // new order computed above; current track finishes its slot
    }

    // A changed library composition clears the given-up state and streaks.
    const orderKey = order.join("\n") + (m.shuffle ? "|s" : "|l");
    if (orderKey !== lastOrderKey) {
      lastOrderKey = orderKey;
      errorStreak = 0;
      lastErrorKey = "";
      if (state === "error") state = "off";
    }

    if (!m.enabled || !order.length || duckedByScene()) {
      if (el && !el.paused) {
        if (fade.target !== 0) fadeTo(0, () => el.pause());  // don't restart an in-flight fade
      } else if (fade.timer === null) { fade.factor = 0; applyVolume(); }
      state = m.enabled && order.length ? "paused" : "off";
      return;
    }

    if (!current || order.indexOf(current) < 0) {
      // fresh start, or the playing track was disabled/deleted: resume the
      // remembered track when it is still in the order, else the top
      let file = null;
      try {
        const s = JSON.parse(localStorage.getItem(LS_KEY) || "null");
        if (s && order.includes(s.file)) file = s.file;
      } catch (e) { }
      loadTrack(file || order[0]);
    } else if (advance) {
      errorStreak = 0;                             // an explicit skip retries a sulking library
      lastErrorKey = "";
      state = "off";
      nextTrack();
      return;
    } else {
      el.loop = order.length === 1;
    }

    if (state === "error") return;                 // silent until the library or a nudge changes
    if (el.paused || blocked) startPlayback();     // resume keeps mid-track position
    else {
      state = "playing";
      // Already audible — but a duck's fade-to-pause may still be in flight
      // (its pause lands on a throttled timer). Steer the fade back up so a
      // stale kill-timer can never silence a track we decided should play.
      if (fade.target !== 1) fadeTo(1);
    }
  }

  /* ------------------------------------------------------ element events */

  function onPlaying() {
    blocked = false;
    errorStreak = 0;
    lastErrorKey = "";
    state = "playing";
  }

  function onEnded() {                             // loop the ORDER, in full
    // A track can run out while a duck/stop fade is still heading for its
    // pause — advancing then would restart the bed mid-intermission.
    // Reconcile owns the resume; play() on the ended element replays it.
    const m = cfg && cfg.loaded ? (cfg.data.music || {}) : {};
    if (!m.enabled || duckedByScene()) return;
    nextTrack();
  }

  // One bad file raises both the element's error event and a play()
  // rejection — count each load once, or a single dud would double-advance.
  let lastErrorKey = "";
  function onError() {
    const m = cfg && cfg.loaded ? (cfg.data.music || {}) : {};
    if (!m.enabled || !order.length || !current) return;
    if (el.src && el.src === lastErrorKey) return;
    lastErrorKey = el.src;
    errorStreak++;
    if (errorStreak >= order.length) {             // whole library unplayable — stop trying,
      state = "error";                             // heartbeat tells admin; config change retries
      return;
    }
    setTimeout(() => {                             // state may have moved in the meantime
      const mm = cfg.data.music || {};
      if (mm.enabled && order.length && !duckedByScene()) nextTrack();
    }, 500);
  }

  /* ------------------------------------------------------------- status */

  function status() {
    return {
      state,
      file: current || null,
      index: current ? order.indexOf(current) + 1 : 0,
      of: order.length,
      pos_s: el && el.currentTime ? Math.round(el.currentTime) : 0,
      dur_s: el && isFinite(el.duration) && el.duration ? Math.round(el.duration) : 0,
    };
  }

  /* --------------------------------------------------------------- init */

  function init(configStore) {
    cfg = configStore;
    const q = new URLSearchParams(location.search);
    inert = q.get("music") === "0" || q.get("music") === "off";
    if (inert) return;

    el = document.createElement("audio");
    el.preload = "auto";
    el.volume = 0;
    el.addEventListener("playing", onPlaying);
    el.addEventListener("ended", onEnded);
    el.addEventListener("error", onError);
    // never appended to the stage — audio needs no box on a 1920×1080 canvas
    document.body.appendChild(el);

    SCC.config.onChange(() => reconcile());
    SCC.scenes.onSceneChange(() => reconcile());
  }

  return { init, status };
})();
