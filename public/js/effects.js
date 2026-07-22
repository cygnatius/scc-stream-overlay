/* =========================================================================
   effects.js — optional sound + visual cues when results update.

   Two events, both strictly opt-in (config/effects.json, master OFF):

   FEATURED RESULT — the streamed game's result landing. Fired when the
   resolved result (manual postgame text, or the Pairingsman auto value,
   exactly as the display resolves it) changes while the postgame scene is
   up, or on entering postgame with a result that has not been celebrated
   yet — the reveal moment. Each result value celebrates ONCE.

   OTHER GAMES — a data zone's content changing (Pairingsman refresh or a
   manual-lines edit). Only zones visible in the CURRENT scene count, and
   only zones present both before and after — a zone appearing with a scene
   switch is not a result update. The card pulses, changed lines glow, and
   one cue covers a whole update wave.

   Sound engine: WebAudio. Built-in synth presets (chime / bell / blip) need
   no files at all; custom one-shots live in assets/sfx/. A suspended
   context (strict browser tab, never OBS) skips the cue — a late chime is
   worse than none — reports "blocked" via the heartbeat, and retries after
   the first gesture. `?music=0` (the second-display escape) silences ALL
   audio from this instance, cues included; visuals still render.

   Admin nudges (test-fire) ride effects.json as counters, consumed as
   CHANGES like the music module's, so a display reload never replays them.
   admin.html loads this file for preview() alone — everything outside
   init() must run without config/scenes present.

   Classic script; exposes window.SCC.effects. Requires vue.global.js;
   init() additionally needs config.js, scenes.js, zones.js.
   ========================================================================= */
"use strict";
window.SCC = window.SCC || {};

SCC.effects = (function () {
  // Reactive view consumed by the display: resultKey bumps remount the
  // postgame result element (replaying its pop animation); zones[id] =
  // {key, live, lines[]} drives the data-card pulse + line glow.
  const view = Vue.reactive({ resultKey: 0, zones: {} });

  let cfg = null;                       // SCC.config.store (display only)
  let audioInert = false;               // ?music=0 — this instance emits no audio at all
  let ctx = null;
  let blocked = false;                  // context suspended when a cue tried to play
  const bufCache = {};                  // sfx filename → Promise<AudioBuffer>
  const zoneTimers = {};
  let zkey = 0;
  let lastTest = null;                  // consumed test_count (null until first config)
  let lastCelebrated = "";              // result value already celebrated

  /* --------------------------------------------------- WebAudio engine */

  function ensureCtx() {
    if (!ctx) {
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { return null; }
    }
    if (ctx.state === "suspended") { try { ctx.resume(); } catch (e) { } }
    return ctx;
  }

  function note(c, freq, t0, vol, decay, type) {
    const o = c.createOscillator();
    o.type = type || "sine";
    o.frequency.setValueAtTime(freq, t0);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol), t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.012 + decay);
    o.connect(g);
    g.connect(c.destination);
    o.start(t0);
    o.stop(t0 + decay + 0.1);
  }

  // Built-in cues — tuned quiet and round, nothing brash on a chess stream.
  const SYNTHS = {
    chime(c, vol) {                      // two rising notes: "the result is in"
      const t = c.currentTime + 0.02;
      note(c, 659.25, t, vol * 0.7, 0.55);          // E5
      note(c, 1318.5, t, vol * 0.12, 0.5);          // faint octave sparkle
      note(c, 880.0, t + 0.17, vol * 0.8, 0.8);     // A5
      note(c, 1760.0, t + 0.17, vol * 0.12, 0.7);
    },
    bell(c, vol) {                       // one round strike with soft partials
      const t = c.currentTime + 0.02;
      note(c, 1046.5, t, vol * 0.8, 1.1);
      note(c, 1046.5 * 2.4, t, vol * 0.18, 0.6);
      note(c, 1046.5 * 3.9, t, vol * 0.08, 0.35);
    },
    blip(c, vol) {                       // short quiet tick for background games
      const t = c.currentTime + 0.02;
      note(c, 523.25, t, vol * 0.5, 0.16, "triangle");
      note(c, 784.0, t + 0.05, vol * 0.35, 0.18, "triangle");
    },
  };

  async function playFile(name, vol) {
    const c = ctx;                       // caller has ensured a running context
    if (!bufCache[name]) {
      bufCache[name] = fetch("/assets/sfx/" + encodeURIComponent(name))
        .then(r => { if (!r.ok) throw new Error("sfx " + r.status); return r.arrayBuffer(); })
        .then(ab => c.decodeAudioData(ab));
      bufCache[name].catch(() => { delete bufCache[name]; });
    }
    try {
      const buf = await bufCache[name];
      const src = c.createBufferSource();
      src.buffer = buf;
      const g = c.createGain();
      g.gain.value = vol;
      src.connect(g);
      g.connect(c.destination);
      src.start();
    } catch (e) { /* missing or undecodable — silent on air; admin preview surfaces it */ }
  }

  // sound: "" | "chime" | "bell" | "blip" | "file:<name>"; volume 0–100.
  function play(sound, volume) {
    if (!sound) return;
    const c = ensureCtx();
    if (!c) return;
    if (c.state === "suspended") {       // strict tab without a gesture yet:
      blocked = true;                    // skip — a late cue is worse than none
      return;
    }
    blocked = false;
    const vol = Math.max(0, Math.min(1, (Number(volume) || 0) / 100));
    if (!vol) return;
    if (sound.indexOf("file:") === 0) playFile(sound.slice(5), vol);
    else if (SYNTHS[sound]) SYNTHS[sound](c, vol);
  }

  // Admin preview — a button click IS the activation gesture, so this plays
  // where fire-and-forget cues would be blocked. Needs no init().
  function preview(sound, volume) { play(sound, volume); }

  /* ------------------------------------------------------------ firing */

  function fxCfg() { return (cfg && cfg.loaded && cfg.data.effects) || {}; }

  function fireFeatured(test) {
    const e = fxCfg();
    if (!test && !e.enabled) return;
    const ev = e.featured_result || {};
    if (ev.visual !== false) view.resultKey++;
    if (!audioInert) play(typeof ev.sound === "string" ? ev.sound : "", ev.volume);
  }

  // hits: [{id, lines:[changed indexes]}] — one cue per wave, however many cards.
  function fireZoneHits(hits, test) {
    const e = fxCfg();
    if (!test && !e.enabled) return;
    const ev = e.other_results || {};
    if (ev.visual !== false) {
      for (const h of hits) {
        view.zones[h.id] = { key: ++zkey, live: true, lines: h.lines };
        clearTimeout(zoneTimers[h.id]);
        zoneTimers[h.id] = setTimeout(() => {
          const z = view.zones[h.id];
          if (z) z.live = false;         // class off; entry stays so the next fire remounts
        }, 2400);
      }
    }
    if (!audioInert) play(typeof ev.sound === "string" ? ev.sound : "", ev.volume);
  }

  /* ----------------------------------------------------------- sources */

  // The result exactly as the display resolves it: hidden → nothing;
  // auto → Pairingsman value when present, else manual; manual → manual.
  // pm.auto("result") is already the display label STRING (the adaptor
  // unwraps result.label) — mirror fieldVal() in display.html verbatim so
  // this celebrates precisely what goes on air.
  function resolvedResult() {
    const sc = (cfg.data.scenes.scenes || {}).postgame || {};
    const manual = sc.result_text || "";
    const pm = window.SCC.pairingsman;
    if (!pm) return manual;
    const mode = pm.fieldMode("result");
    if (mode === "hidden") return "";
    if (mode === "auto") {
      const a = pm.auto("result");
      if (a != null && a !== "") return String(a);
    }
    return manual;
  }

  // Data zones the CURRENT scene actually renders — mirrors display markup.
  // Reactive reads (scene, cfg.loaded) come before every early return, or
  // the watcher would freeze on its first value (bitten twice before).
  function visibleDataZones() {
    const scene = SCC.scenes.view.current;
    if (!cfg.loaded) return [];
    let list;
    if (scene === "intermission") list = [];
    else if (scene === "game") list = SCC.zones.gameSideZones().concat(SCC.zones.gameStripZones());
    else list = SCC.zones.bandZones();
    return list.filter(z => z.kind === "data").map(z => ({ id: z.id, cap: z.cap, lines: z.lines }));
  }

  /* ------------------------------------------------------------- status */

  function status() {
    return { audio: blocked ? "blocked" : (ctx && ctx.state === "running" ? "ready" : "idle") };
  }

  /* --------------------------------------------------------------- init */

  function init(configStore) {
    cfg = configStore;
    const q = new URLSearchParams(location.search);
    audioInert = q.get("music") === "0" || q.get("music") === "off";

    // Any first gesture wakes the audio engine in a strict browser tab —
    // OBS starts it running, so this is for operator test tabs only.
    const wake = () => {
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
      if (ensureCtx() && ctx.state !== "suspended") blocked = false;
    };
    window.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", wake);

    // Featured result: change while postgame is up = celebrate now.
    Vue.watch(() => resolvedResult(), (n) => {
      if (n === lastCelebrated) return;
      if (!n) { lastCelebrated = ""; return; }
      if (SCC.scenes.view.current === "postgame") {
        lastCelebrated = n;
        fireFeatured(false);
      }                                  // else: the scene-enter reveal below fires it
    });
    SCC.scenes.onSceneChange((to) => {
      if (to !== "postgame") return;
      const r = resolvedResult();
      if (r && r !== lastCelebrated) {
        lastCelebrated = r;
        fireFeatured(false);
      }
    });

    // Other games: content changes on zones present before AND after.
    Vue.watch(() => JSON.stringify(visibleDataZones()), (nStr, oStr) => {
      if (oStr == null) return;
      const now = JSON.parse(nStr), old = JSON.parse(oStr);
      const oldById = {};
      for (const z of old) oldById[z.id] = z;
      const hits = [];
      for (const z of now) {
        const o = oldById[z.id];
        if (!o || JSON.stringify(o) === JSON.stringify(z)) continue;
        const changed = [];
        for (let i = 0; i < z.lines.length; i++) if (z.lines[i] !== o.lines[i]) changed.push(i);
        hits.push({ id: z.id, lines: changed });
      }
      if (hits.length) fireZoneHits(hits, false);
    });

    // Admin test-fire: counters consumed as changes, never replayed on boot.
    SCC.config.onChange(() => {
      const e = fxCfg();
      const n = Number(e.test_count) || 0;
      if (lastTest === null) { lastTest = n; return; }
      if (n === lastTest) return;
      lastTest = n;
      if (e.test_event === "other_results") {
        const zs = visibleDataZones();
        fireZoneHits(zs.map(z => ({ id: z.id, lines: z.lines.map((_, i) => i) })), true);
      } else {
        fireFeatured(true);
      }
    });
  }

  return { init, view, status, preview };
})();
