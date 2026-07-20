/* =========================================================================
   zones.js — sponsor & data zones (stage 4).

   Six-slot model: left / centre / right, each WHOLE or SPLIT into top and
   bottom (nine addressable ids, at most six rendering). Availability is
   per scene — the scene's geometry decides, not the config:

     start · versus · postgame · ending → all three columns, as a band
     game → the right column only, rendered in the side panel between the
       moves and the funder credit. Enabling the bottom strip
       (scenes.json → scenes.game.bottom_strip) relocates ALL columns into
       a strip above the footer instead — left and centre gain a game-scene
       home, and right moves down with them so content is never duplicated.

   Slot content: a sponsor tier (rotating through the active sponsors of
   that tier), a data block (manual lines this stage; the Pairingsman auto
   source arrives in its stage and falls through to manual, then hidden),
   or — active but unassigned — the "advertise here" invite. Inactive
   slots render nothing at all: with every slot inactive the game scene is
   identical to the pre-zone overlay.

   Rotation: one 500ms ticker over per-slot deadlines (rotate_ms, min 2s),
   held in a Vue-reactive map so the display crossfades with the original
   .slogo opacity transition. Config writes never reset the phase of
   untouched slots; a shrunken sponsor list just wraps the index.

   Classic script; exposes window.SCC.zones. Requires vue.global.js,
   config.js.
   ========================================================================= */
"use strict";
window.SCC = window.SCC || {};

SCC.zones = (function () {
  const COLS = ["left", "centre", "right"];
  const TIERS = ["premier", "major", "regular", "minor"];
  const KIND_LABEL = {
    tournament_leaderboard: "Tournament standings",
    meeting_leaderboard: "Tonight’s standings",
    concurrent_pairings: "Also playing tonight",
    results: "Results",
  };

  let cfg = null;                      // SCC.config.store
  const rot = Vue.reactive({});        // slotId → { idx, at } rotation phase

  /* ------------------------------------------------------------ helpers */

  function slotsOfColumn(col) {
    const c = ((cfg.data.zones.columns || {})[col]) || {};
    return c.split ? [col + "_top", col + "_bottom"] : [col];
  }

  function activeSponsors(tier) {
    return (cfg.data.sponsors.sponsors || [])
      .filter(s => s && s.active !== false && s.tier === tier && (s.name || s.image));
  }

  function stripOn() {
    const g = (cfg.data.scenes.scenes || {}).game || {};
    return !!g.bottom_strip;
  }

  /* Resolve one slot id to a renderable descriptor, or null (nothing). */
  function resolve(id) {
    const s = (cfg.data.zones.slots || {})[id];
    if (!s || !s.active) return null;

    if (s.source === "data") {
      if (s.data_mode === "hidden") return null;
      // auto = the Pairingsman payload; it falls through to the manual lines
      // when absent, and with none of those either the slot renders nothing —
      // a data zone must never show a placeholder on air.
      let lines = null;
      if (s.data_mode === "auto" && window.SCC.pairingsman) {
        lines = SCC.pairingsman.dataLines(s.data_kind);
      }
      if (!lines) {
        lines = (Array.isArray(s.data_lines) ? s.data_lines : [])
          .map(l => String(l).trim()).filter(Boolean);
      }
      lines = lines.slice(0, 8);
      if (!lines.length) return null;
      return { kind: "data", id, cap: s.data_title || KIND_LABEL[s.data_kind] || "Results", lines };
    }

    // sponsors — no (valid) tier assigned means the designed invite card
    if (!TIERS.includes(s.tier)) return { kind: "advertise", id, cap: "Sponsorship available" };
    const list = activeSponsors(s.tier);
    if (!list.length) return { kind: "advertise", id, cap: "Sponsorship available" };
    const idx = (rot[id] ? rot[id].idx : 0) % list.length;
    return {
      kind: "sponsor", id, list, idx,
      show: ["image", "message", "both"].includes(s.show) ? s.show : "both",
      cap: list[idx].header || "Proudly supported by",
    };
  }

  /* ------------------------------------------------- per-scene queries */

  // Open scenes (start/versus/postgame/ending): every column, as a band.
  function bandZones() {
    if (!cfg || !cfg.loaded) return [];
    return COLS.flatMap(slotsOfColumn).map(resolve).filter(Boolean);
  }

  // Game scene side panel: the right column — empty when the strip owns it.
  function gameSideZones() {
    if (!cfg || !cfg.loaded || stripOn()) return [];
    return slotsOfColumn("right").map(resolve).filter(Boolean);
  }

  // Game scene bottom strip: all columns when enabled, else nothing.
  function gameStripZones() {
    if (!cfg || !cfg.loaded || !stripOn()) return [];
    return COLS.flatMap(slotsOfColumn).map(resolve).filter(Boolean);
  }

  /* ---------------------------------------------------------- rotation */

  function tick() {
    if (!cfg || !cfg.loaded) return;
    const now = Date.now();
    const slots = cfg.data.zones.slots || {};
    for (const id of Object.keys(slots)) {
      const s = slots[id];
      if (!s || !s.active || s.source === "data" || !TIERS.includes(s.tier)) continue;
      const n = activeSponsors(s.tier).length;
      if (n < 2) continue;                             // nothing to rotate
      const r = rot[id] || (rot[id] = { idx: 0, at: now });
      const iv = Math.max(2000, Number(s.rotate_ms) || 8000);
      if (now - r.at >= iv) { r.idx = (r.idx + 1) % n; r.at = now; }
    }
  }

  function init(configStore) {
    cfg = configStore;
    setInterval(tick, 500);
  }

  return { init, bandZones, gameSideZones, gameStripZones, TIERS, KIND_LABEL };
})();
