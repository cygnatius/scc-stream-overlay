/* =========================================================================
   config.js — reactive config store + LOCAL CONFIG POLL LOOP.

   This is one of the TWO independent poll loops and must never be conflated
   with the Pairingsman refresh (pairingsman.js, far slower, network-bound).
   This loop is local disk only:

     every config_poll_ms (default 500):  GET /api/config/hash
     hash changed?                     →  GET /api/config → update reactive state

   A failed poll never blanks the display — the last known good config stays
   in place and store.ok flips false so the display can show a subtle warning.

   Classic script; exposes window.SCC.config. Requires vendor/vue.global.js.
   ========================================================================= */
"use strict";
window.SCC = window.SCC || {};

SCC.config = (function () {
  // Minimal boot shape so templates render before the first fetch lands.
  // The server merges every file over full defaults, so one successful fetch
  // replaces this with the complete config.
  const BOOT = {
    general: { event_title: "", round: "", table_name: "", table_number: "", location: "",
               social_links: [], website: "", config_poll_ms: 500 },
    board: { serialnr: "", host: "127.0.0.1", port: 1982, manual_host_override: false,
             manual_host: "", poll_ms: 800, demo_mode: false },
    scenes: { active: "game", scenes: {} },
    sponsors: { sponsors: [] },
    zones: { slots: {}, funder: { enabled: false, text: "", logo: "" } },
    players: { global_photo_mode: "photos_and_avatars",
               manual: { white: {}, black: {} }, roster: [] },
    pairingsman: { base_url: "", token: "", entity_type: "meeting", entity_id: null,
                   refresh_ms: 30000, fields: {} },
  };

  const store = Vue.reactive({
    data: BOOT,
    hash: "",
    ok: false,          // last poll succeeded
    loaded: false,      // at least one full config has been applied
  });

  const changeListeners = [];
  function onChange(fn) { changeListeners.push(fn); }

  function applyConfig(config, hash) {
    const old = store.loaded ? store.data : null;
    store.data = config;
    store.hash = hash;
    store.loaded = true;
    for (const fn of changeListeners) {
      try { fn(config, old); } catch (e) { console.warn("[config] change listener failed:", e); }
    }
  }

  async function fetchFull() {
    const r = await fetch("/api/config", { cache: "no-store" });
    if (!r.ok) throw new Error("config fetch " + r.status);
    const j = await r.json();
    applyConfig(j.config, j.hash);
  }

  let timer = null;
  async function tick() {
    try {
      if (!store.loaded) {
        await fetchFull();
      } else {
        const r = await fetch("/api/config/hash", { cache: "no-store" });
        if (!r.ok) throw new Error("hash fetch " + r.status);
        const j = await r.json();
        if (j.hash !== store.hash) await fetchFull();
      }
      store.ok = true;
    } catch (e) {
      store.ok = false;               // keep last known good data on screen
    }
    const interval = Math.max(150, Number(store.data.general.config_poll_ms) || 500);
    timer = setTimeout(tick, interval);
  }

  function start() {
    if (timer !== null) return;
    tick();
  }

  return { store, start, onChange };
})();
