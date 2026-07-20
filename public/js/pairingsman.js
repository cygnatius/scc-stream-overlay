/* =========================================================================
   pairingsman.js — the READ-ONLY Pairingsman broadcast client (stage 6).

   Built AHEAD of the server per the project decision: the broadcast
   endpoints and their composed payload are being delivered on the
   Pairingsman side as docs/operations/broadcast-api.md. That document is
   AUTHORITATIVE. Everything this module assumes about the payload lives in
   ONE place — adaptPayload() below — and every read degrades to null, so a
   shape mismatch can only ever fall back to manual values, never break the
   stream. When broadcast-api.md lands, verify adaptPayload() against it.

   Grounded in the LANDED general API contract (docs/operations/api.md in
   the Pairingsman repo): Sanctum bearer auth, Accept: application/json,
   responses wrapped in { data: … }, 404 for anything the token can't see,
   result as a structured object whose `label` is displayed as received
   (never translated), *_seconds fields are raw seconds, rate limit
   60 req/min (the 30s default refresh uses 2).

   RULES (from the brief):
   - This is the SECOND, far slower poll loop. Never tied to the config
     poll. Fetch on entity selection; refresh on refresh_ms (default 30s).
   - One composed request per refresh. No follow-up calls.
   - The display calls Pairingsman DIRECTLY — the local server never
     proxies it (Pairingsman must allow the overlay origin via CORS).
   - Cache the last successful payload. A failed refresh keeps last good
     data on screen and sets an internal flag. 404 → "not found or not
     visible to this token" in admin, silent degradation on stream.
   - Timestamps carry +10:00/+11:00 offsets — display the WALL TIME as
     written (never convert through the machine timezone).
   - Every key always present, absent = null. null → manual value → hidden.
   - The token is a credential: never logged, never rendered into errors.

   Classic script; exposes window.SCC.pairingsman. Requires vue.global.js,
   config.js.
   ========================================================================= */
"use strict";
window.SCC = window.SCC || {};

SCC.pairingsman = (function () {
  const FIELDS = [
    "event_title", "venue", "schedule", "table", "players",
    "result", "feature_matches", "next_meeting",
  ];

  let cfg = null;                        // SCC.config.store

  const state = Vue.reactive({
    status: "off",                       // off | loading | live | stale | notfound | denied
    fetchedAt: 0,
    entity: "",                          // "meeting 12" — admin display
    rev: 0,                              // bumped when adapted data changes
  });

  let adapted = null;                    // last GOOD adapted payload (never blanked)
  let cur = { base: undefined, token: undefined, type: undefined, id: undefined, refresh: undefined };
  let timer = null;

  /* --------------------------------------------------------- wall time */
  // "2026-07-23T19:30:00+10:00" → "19:30" / "Thursday 23 July", read from
  // the string itself so the venue offset is honoured verbatim.
  function isoHM(iso) {
    const m = /T(\d{2}):(\d{2})/.exec(String(iso || ""));
    return m ? m[1] + ":" + m[2] : "";
  }
  function isoDateLabel(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
    if (!m) return "";
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));   // date part only — offset-safe
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    return days[d.getUTCDay()] + " " + d.getUTCDate() + " " + months[d.getUTCMonth()];
  }

  // wins/draws/losses ints → "4–1–2" (W–D–L) or "1–4" (W–L when no draws).
  function fmtRecord(w, d, l) {
    if (w == null || l == null) return "";
    return d ? `${w}–${d}–${l}` : `${w}–${l}`;
  }

  /* ------------------------------------------------------------ ADAPTOR
     The ONLY place that touches the composed broadcast payload shape.
     AUTHORITATIVE CONTRACT: docs/operations/broadcast-api.md (Pairingsman
     repo). Field names below follow the project brief; every read is
     null-safe and optional, so a differing shape yields nulls → manual.  */
  function adaptPayload(d) {
    if (!d || typeof d !== "object") return null;
    const player = (p) => !p ? null : {
      name: p.name || "",
      title: p.title || "",
      rating: p.rating == null ? null : p.rating,
      record: p.record || fmtRecord(p.wins, p.draws, p.losses),
      photo_url: p.photo_url || "",      // absolute URL or null = like a missing local photo
    };
    const pair = (x) => !x ? null : {
      surface: (x.surface && (x.surface.name || x.surface)) || x.table || "",
      white: (x.white && (x.white.name || x.white)) || "",
      black: (x.black && (x.black.name || x.black)) || "",
      label: (x.result && x.result.label) || null,
      scheduled_start: x.scheduled_start || null,
    };
    const rows = (a, fn) => Array.isArray(a) ? a.map(fn).filter(Boolean) : null;
    return {
      event_title: (d.event && (d.event.title || d.event.name)) || null,
      venue: (d.venue && d.venue.name) || null,
      schedule: d.schedule ? { open: d.schedule.open || null, close: d.schedule.close || null } : null,
      table: d.table ? { name: d.table.name || "", number: d.table.number ?? null } : null,
      players: d.players ? { white: player(d.players.white), black: player(d.players.black) } : null,
      result: d.result || null,          // structured object; label displayed as received
      feature_matches: rows(d.feature_matches, pair),
      next_meeting: d.next_meeting
        ? { open: d.next_meeting.open || null, close: d.next_meeting.close || null, venue: (d.next_meeting.venue && (d.next_meeting.venue.name || d.next_meeting.venue)) || "" }
        : null,
      standings: {                       // zone data blocks
        tournament_leaderboard: rows(d.tournament_leaderboard, r => r && `${r.rank != null ? r.rank + ". " : ""}${r.name || ""}${r.score != null ? " — " + r.score : ""}`.trim()),
        meeting_leaderboard: rows(d.meeting_leaderboard, r => r && `${r.rank != null ? r.rank + ". " : ""}${r.name || ""}${r.score != null ? " — " + r.score : ""}`.trim()),
        concurrent_pairings: rows(d.concurrent_pairings, p => { const x = pair(p); return x && `${x.surface ? x.surface + ": " : ""}${x.white} v ${x.black}`.trim(); }),
        results: rows(d.results, p => { const x = pair(p); return x && `${x.white} ${x.label || "v"} ${x.black}`.trim(); }),
      },
    };
  }

  /* ---------------------------------------------------------- transport */

  function pmCfg() { return (cfg.data && cfg.data.pairingsman) || {}; }

  function endpoint(pc) {
    const base = String(pc.base_url || "").trim().replace(/\/+$/, "");
    const type = { tournament: "tournaments", meeting: "meetings", pairing: "pairings" }[pc.entity_type] || null;
    const id = pc.entity_id;
    if (!base || !type || id == null || id === "") return null;
    return `${base}/api/v1/broadcast/${type}/${encodeURIComponent(id)}`;
  }

  async function fetchOnce() {
    const pc = pmCfg();
    const url = endpoint(pc);
    if (!url || !pc.token) { state.status = "off"; return; }
    state.entity = pc.entity_type + " " + pc.entity_id;
    try {
      const r = await fetch(url, {
        headers: { Authorization: "Bearer " + pc.token, Accept: "application/json" },
        cache: "no-store",
      });
      if (r.status === 404) {            // inaccessible or wrong-association id — per contract
        if (!adapted) state.status = "notfound";
        else if (state.status !== "notfound") { state.status = "notfound"; }   // held data stays
        return;
      }
      if (r.status === 401 || r.status === 403) {
        state.status = adapted ? "stale" : "denied";
        return;
      }
      if (!r.ok) { if (adapted) state.status = "stale"; return; }
      const j = await r.json();
      const a = adaptPayload(j && j.data); // Laravel envelope: payload under data
      if (a) {
        adapted = a;
        state.fetchedAt = Date.now();
        state.status = "live";
        state.rev++;
      } else if (adapted) state.status = "stale";
    } catch (e) {
      // network/CORS failure: keep last good data, flag only
      if (adapted) state.status = "stale";
      else if (state.status !== "off") state.status = "stale";
    }
  }

  function loop() {
    clearTimeout(timer);
    const pc = pmCfg();
    const interval = Math.max(5000, Number(pc.refresh_ms) || 30000);
    timer = setTimeout(async () => { await fetchOnce(); loop(); }, interval);
  }

  // Config diffing: only a connection-relevant change refetches/resets.
  // Unrelated config writes never touch this loop (mirrors livechess.apply).
  function apply() {
    const pc = pmCfg();
    const next = {
      base: String(pc.base_url || "").trim(),
      token: String(pc.token || ""),
      type: pc.entity_type, id: pc.entity_id,
      refresh: Math.max(5000, Number(pc.refresh_ms) || 30000),
    };
    const first = cur.base === undefined;
    const connChanged = first || next.base !== cur.base || next.token !== cur.token
      || next.type !== cur.type || String(next.id) !== String(cur.id);
    const refreshChanged = !first && next.refresh !== cur.refresh;
    cur = next;
    if (connChanged) {
      adapted = null;                     // a different entity is different data
      state.rev++;
      state.status = "off";
      state.fetchedAt = 0;
      if (endpoint(pc) && next.token) { state.status = "loading"; fetchOnce().then(loop); }
      else clearTimeout(timer);
    } else if (refreshChanged) loop();
  }

  /* ------------------------------------------------------- field access */

  function fieldMode(name) {
    const f = pmCfg().fields || {};
    const m = f[name];
    return m === "manual" || m === "hidden" ? m : "auto";
  }

  // The adapted auto value for a display field, or null (→ manual fallback).
  // state.rev is read BEFORE any early return: a computed whose first run
  // lands pre-fetch must still track it, or it freezes on null forever.
  function auto(name) {
    void state.rev;
    if (!adapted) return null;
    switch (name) {
      case "event_title": return adapted.event_title;
      case "venue": return adapted.venue;
      case "schedule": return adapted.schedule;
      case "table": return adapted.table;
      case "players": return adapted.players;
      case "result": return adapted.result && adapted.result.label ? adapted.result.label : null;
      case "feature_matches": return adapted.feature_matches && adapted.feature_matches.length ? adapted.feature_matches : null;
      case "next_meeting": return adapted.next_meeting;
      default: return null;
    }
  }

  // Zone data blocks: lines for a kind, or null (zone falls back to manual).
  function dataLines(kind) {
    void state.rev;                      // reactive read first — see auto()
    if (!adapted) return null;
    const rows = adapted.standings[kind];
    return rows && rows.length ? rows : null;
  }

  function init(configStore) {
    cfg = configStore;
    SCC.config.onChange(() => apply());
    if (cfg.loaded) apply();
  }

  // adapt is exported for the admin page's side-by-side preview, so the
  // payload assumptions live in exactly one function repo-wide.
  return { init, state, fieldMode, auto, dataLines, isoHM, isoDateLabel, fmtRecord, adapt: adaptPayload, FIELDS };
})();
