/* =========================================================================
   SCC Broadcast Overlay — local server
   Single file, zero dependencies: node http + fs + path only.
   Binds 127.0.0.1 ONLY — never exposed to the network.

   Serves:
     /                → public/display.html
     /display.html    → public/  (OBS browser source)
     /admin.html      → public/  (operator control panel)
     /js/*  /vendor/* /assets/*  → static files
   API (all responses no-store):
     GET  /api/config        → every config file merged over defaults + mtime hash
     GET  /api/config/hash   → just the hash (cheap; display polls this)
     POST /api/config/:name  → replace one config file (validated, atomic write)
     POST /api/asset         → { kind, filename, data(base64) } → assets/<kind>/
     POST /api/asset/delete  → { kind, name } — music library only
     GET  /api/assets/:kind  → list files in assets/<kind> (video picker etc.)
   ========================================================================= */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const ASSETS_DIR = path.join(ROOT, "assets");
const VENDOR_DIR = path.join(ROOT, "vendor");
const CONFIG_DIR = path.join(ROOT, "config");

const HOST = "127.0.0.1";               // hard requirement: loopback only
const PORT = Number(process.env.SCC_PORT) || 8420;

const MAX_BODY = 20 * 1024 * 1024;      // 20 MB — covers player photos / sponsor logos

/* ------------------------------------------------------------------------
   Config defaults — one object per config file. A missing or malformed file
   falls back to these and logs a warning; it never crashes the display.
   The merged (defaults ⊕ file) object is what /api/config returns, so the
   display always receives a complete shape.
   ------------------------------------------------------------------------ */
// Zone slot ids: left/centre/right, each whole or split into top+bottom.
// Nine addressable ids; the ones that render are those consistent with the
// column split state, and at most six can render at once.
const ZONE_SLOT_IDS = [
  "left", "left_top", "left_bottom",
  "centre", "centre_top", "centre_bottom",
  "right", "right_top", "right_bottom",
];
function defaultZoneSlot() {
  return {
    active: false,                       // every slot OFF by default: overlay renders as today
    source: "sponsors",                  // sponsors | data ("sponsors" with no tier = advertise-here invite)
    tier: "",                            // premier | major | regular | minor | "" (unassigned)
    rotate_ms: 8000,                     // sponsor rotation frequency
    show: "both",                        // image | message | both
    data_kind: "results",                // tournament_leaderboard | meeting_leaderboard | concurrent_pairings | results
    data_mode: "manual",                 // auto (Pairingsman, its stage) | manual | hidden
    data_title: "",
    data_lines: [],                      // manual content, one display line per entry
  };
}
const DEFAULT_ZONE_SLOTS = {};
for (const id of ZONE_SLOT_IDS) DEFAULT_ZONE_SLOTS[id] = defaultZoneSlot();

const CONFIG_DEFAULTS = {
  general: {
    event_title: "Club Championship 2026",
    season: "",
    round: "Round 4",
    table_name: "",                      // free-text label; falls back to "Board <table_number>"
    table_number: 1,
    location: "Shepparton Mechanics Institute",
    time_control: "",
    running_time_start: "",              // "19:30" — manual fallback for the start scene
    running_time_end: "",
    social_links: [
      { label: "chess.com", url: "" },
      { label: "lichess.org", url: "" },
    ],
    website: "sheppartonchess.club",
    feature_match_time: "",              // manual fallback when Pairingsman has no feature_start
    config_poll_ms: 500,                 // display → /api/config/hash interval
    next_broadcast: {
      mode: "auto",                      // auto | manual | hidden
      manual_date: "",
      manual_time: "",
      label: "Next broadcast",
      recurrence_days: 7,                // computed default: same weekday/time N days on
    },
  },

  board: {
    serialnr: "3000150100",
    host: "127.0.0.1",                   // LiveChess runs on this machine (single-machine venue)
    port: 1982,
    manual_host_override: false,         // two-machine fallback: override host manually
    manual_host: "",
    poll_ms: 800,                        // eboards poll over the LiveChess websocket
    demo_mode: false,                    // true = show the built-in demo game (design aid).
                                         // Fake names must never reach air by accident.
    move_times: true,                    // per-move times beside each move in the list
    pgn: {
      enabled: true,                     // probe LiveChess for the game PGN (times + verification)
      url: "",                           // explicit PGN URL; empty = probe candidates on the host
      poll_ms: 6000,                     // display → /api/pgn cadence (slow; separate from config poll)
    },
  },

  scenes: {
    active: "game",                      // start | versus | game | postgame | intermission | ending
    // A running sequence: {name:"game_start"|"game_end", started_at:<epoch ms>}.
    // The display computes the current phase from started_at, so a reload
    // resumes mid-sequence. null = no sequence; `active` shows directly.
    sequence: null,
    // A cancellable automatic transition awaiting its arm delay:
    // {action:"game_start"|"game_end", fires_at:<epoch ms>, reason:"…"}.
    // Written by the display's detector; cleared by admin cancel, by any
    // manual scene command, or by the display when it fires or loses
    // confidence. null = nothing pending.
    pending_auto: null,
    auto: {
      enabled: false,                    // board-state driven switching; operator opt-in
      arm_delay_ms: 4000,                // cancel window before an auto transition fires
    },
    default_transition: { type: "fade", duration_ms: 1000, delay_ms: 0, direction: "left" },
    transitions: {                       // per-type parameter defaults
      cut: {},
      fade: {},
      crossfade: {},
      slide: { direction: "left" },
      wipe: { direction: "left" },
    },
    scenes: {                            // per-scene settings; transition overrides the default on ENTER
      start: { transition: null },
      versus: { transition: null },
      game: { transition: null, bottom_strip: false },  // strip is stage 4, default OFF
      postgame: { transition: null, result_text: "" },  // manual result until PGN/Pairingsman stages
      intermission: {
        transition: null,
        video: "",                       // filename inside assets/video/
        chapters: [{ start: 0 }],        // chapter start offsets in seconds
        resume_mode: "chapter",          // chapter | exact | rewind | restart
        rewind_ms: 5000,
        loop: true,
        muted: false,
      },
      ending: { transition: null },
    },
    sequences: {
      game_start: { versus_ms: 8000 },
      game_end: { postgame_ms: 40000, start_ms: 150000 },
    },
  },

  sponsors: {
    sponsors: [],                        // { name, tier, image, message, header, active }
  },

  zones: {
    // Six-slot model. Availability is per scene (zones.js owns the map):
    // open scenes (start/versus/postgame/ending) show all columns as a band;
    // the game scene shows the right column in the side panel under the
    // moves — unless scenes.json → scenes.game.bottom_strip relocates all
    // columns into a strip above the footer.
    columns: {
      left: { split: false },
      centre: { split: false },
      right: { split: false },
    },
    slots: DEFAULT_ZONE_SLOTS,
    funder: {                            // Council grant credit — preserved exactly as today
      enabled: true,
      text: "Proudly funded by Greater Shepparton City Council Grant Programs",
      logo: "/assets/img/gscc-white.png",
    },
  },

  players: {
    global_photo_mode: "photos_and_avatars",  // photos_and_avatars | photos_only | no_photos
    manual: {                            // labels are literally "White" and "Black"
      white: { name: "", rating: null, record: "", title: "", photo: "" },
      black: { name: "", rating: null, record: "", title: "", photo: "" },
    },
    roster: [],                          // { name, photo, use_photo, rating, record }
  },

  pairingsman: {
    base_url: "",
    token: "",                           // credential — never logged, masked in admin
    entity_type: "meeting",              // tournament | meeting | pairing
    entity_id: null,
    refresh_ms: 30000,                   // live-data refresh; independent of config poll
    fields: {},                          // per-field auto | manual | hidden
  },

  music: {
    enabled: false,                      // master switch — the display plays only while true
    volume: 50,                          // 0–100 on the display's audio element
    shuffle: true,                       // ONE seeded order, looped — never a per-track random pick
    shuffle_seed: 1,                     // Reshuffle bumps this; same seed = same order across reloads
    skip_count: 0,                       // admin Next-track nudge; the display advances on change
    fade_ms: 800,                        // fade on start/stop/scene ducking
    pause_in_intermission: true,         // duck out while the intermission video plays unmuted
    tracks: [],                          // [{ file, enabled }] — files in assets/music; list order = play order when shuffle is off
  },

  effects: {
    enabled: false,                      // master switch — result cues are strictly opt-in
    featured_result: {                   // the streamed game's result landing (postgame scene)
      visual: true,                      // result text pops on reveal / change
      sound: "chime",                    // "" | chime | bell | blip (built-in synth) | file:<assets/sfx name>
      volume: 70,                        // 0–100
    },
    other_results: {                     // data zones changing content (Pairingsman or manual lines)
      visual: true,                      // zone card pulses; changed lines glow
      sound: "blip",
      volume: 45,
    },
    test_count: 0,                       // admin test-fire nudge; the display acts on change
    test_event: "featured_result",       // featured_result | other_results
  },
};

const CONFIG_NAMES = Object.keys(CONFIG_DEFAULTS);

/* ---------------------------------------------------------------- helpers */

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// defaults ⊕ file: missing keys come from defaults, arrays replace wholesale.
function deepMerge(def, val) {
  if (!isPlainObject(def) || !isPlainObject(val)) return val === undefined ? def : val;
  const out = {};
  for (const k of Object.keys(def)) out[k] = deepMerge(def[k], val[k]);
  for (const k of Object.keys(val)) if (!(k in def)) out[k] = val[k];
  return out;
}

// FNV-1a over the config files' name:mtime:size — cheap change detector.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function configHash() {
  const parts = [];
  for (const name of CONFIG_NAMES) {
    const file = path.join(CONFIG_DIR, name + ".json");
    try {
      const st = fs.statSync(file);
      parts.push(name + ":" + st.mtimeMs + ":" + st.size);
    } catch {
      parts.push(name + ":absent");
    }
  }
  return fnv1a(parts.join(";"));
}

function readConfigFile(name) {
  const def = CONFIG_DEFAULTS[name];
  const file = path.join(CONFIG_DIR, name + ".json");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return def;                                        // missing → defaults, silently
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) throw new Error("not an object");
    return deepMerge(def, parsed);
  } catch (e) {
    console.warn(`[config] ${name}.json is malformed (${e.message}) — using defaults`);
    return def;
  }
}

function readAllConfig() {
  const out = {};
  for (const name of CONFIG_NAMES) out[name] = readConfigFile(name);
  return out;
}

// Atomic write: temp file in the same directory, then rename over the target.
function writeFileAtomic(file, contents) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, "." + path.basename(file) + "." + process.pid + ".tmp");
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

/* ------------------------------------------------------------- MIME types */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

const IMAGE_EXT = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"];
const VIDEO_EXT = [".mp4", ".webm", ".ogv", ".mov"];
const AUDIO_EXT = [".mp3", ".m4a", ".aac", ".ogg", ".opus", ".wav", ".flac"];
const ASSET_KINDS = { sponsors: IMAGE_EXT, players: IMAGE_EXT, video: VIDEO_EXT, music: AUDIO_EXT, sfx: AUDIO_EXT };
const UPLOAD_KINDS = ["sponsors", "players", "music", "sfx"]; // videos are placed manually
// Music files dwarf photos (a full classical movement can pass 20 MB), and
// base64 inflates the body by a third again — give /api/asset its own limit.
const ASSET_MAX_BODY = 64 * 1024 * 1024;
const DELETE_KINDS = ["music", "sfx"];                 // admin-managed libraries; images stay manual

/* --------------------------------------------------------------- respond */

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, code, message) {
  sendJSON(res, code, { ok: false, error: message });
}

/* ------------------------------------------------------------ static files */

// Resolve a URL path against its root, refusing anything that escapes it.
function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath).replace(/\+/g, " ");
  const resolved = path.normalize(path.join(root, decoded));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function serveStatic(req, res, root, urlPath) {
  const file = safeJoin(root, urlPath);
  if (!file) return sendError(res, 400, "bad path");
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return sendError(res, 404, "not found");
  }
  if (!st.isFile()) return sendError(res, 404, "not found");

  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const isVideo = VIDEO_EXT.includes(ext);
  // html/js/css/json: no-store so OBS and admin never run a stale overlay.
  // Fonts/images/media barely change and are large-ish: allow a short cache.
  const cache = isVideo || IMAGE_EXT.includes(ext) || AUDIO_EXT.includes(ext)
    || ext === ".woff2" || ext === ".woff" || ext === ".ttf"
    ? "max-age=3600"
    : "no-store";

  const headers = { "Content-Type": type, "Cache-Control": cache, "Accept-Ranges": "bytes" };

  // Range support — required for <video> seeking and chapter resume.
  const range = req.headers.range;
  if (range && st.size > 0) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m && (m[1] !== "" || m[2] !== "")) {
      let start = m[1] === "" ? st.size - Number(m[2]) : Number(m[1]);
      let end = m[1] !== "" && m[2] !== "" ? Number(m[2]) : st.size - 1;
      if (m[1] === "") start = Math.max(0, start);
      end = Math.min(end, st.size - 1);
      if (start > end || start >= st.size) {
        res.writeHead(416, { "Content-Range": `bytes */${st.size}`, "Cache-Control": "no-store" });
        return res.end();
      }
      headers["Content-Range"] = `bytes ${start}-${end}/${st.size}`;
      headers["Content-Length"] = end - start + 1;
      res.writeHead(206, headers);
      if (req.method === "HEAD") return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
  }

  headers["Content-Length"] = st.size;
  res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
}

/* ------------------------------------------------------------- API routes */

function readBody(req, res, cb, limit) {
  const max = limit || MAX_BODY;
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on("data", (c) => {
    size += c.length;
    if (size > max) {
      aborted = true;
      sendError(res, 413, "body too large");
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (aborted) return;
    cb(Buffer.concat(chunks));
  });
  req.on("error", () => {});
}

// Display runtime status — RAM only, never touches disk. The display POSTs its
// heartbeat (~1s: detector state, confidence, effective scene, connection flags)
// and the admin polls it. Kept out of the config store so status churn never
// invalidates the config hash or triggers the display's own poll loop.
let DISPLAY_STATUS = null;
let DISPLAY_STATUS_AT = 0;

/* ---------------------------------------------------------- PGN source
   The display cannot fetch LiveChess's HTTP endpoints itself (no CORS
   headers there), so this loopback server probes for the game PGN on its
   behalf. Candidates derive from the configured LiveChess host; an explicit
   board.pgn.url overrides. The last working URL is sticky, the last good
   text is cached, and a failed probe returns the cache flagged stale — the
   display never sees a blank where it had data. LiveChess absent or serving
   no PGN is a NORMAL state: {status:"absent"}, quietly.                    */
let PGN_CACHE = null;                    // { text, url, at }
let PGN_STICKY_URL = null;
let PGN_LAST_ATTEMPT = 0;

function lcEffectiveHost(b) {
  let h = (b.manual_host_override && b.manual_host) ? String(b.manual_host).trim() : String(b.host || "").trim();
  if (!h) return null;
  if (!h.includes(":")) h = h + ":" + (Number(b.port) || 1982);
  return h;
}

function pgnCandidates(board) {
  const explicit = board.pgn && String(board.pgn.url || "").trim();
  if (explicit) {
    if (/^https?:\/\//i.test(explicit)) return [explicit];
    const host = lcEffectiveHost(board);
    return host ? ["http://" + host + (explicit.startsWith("/") ? "" : "/") + explicit] : [];
  }
  const host = lcEffectiveHost(board);
  if (!host) return [];
  return ["http://" + host + "/pgn", "http://" + host + "/pgn/games.pgn", "http://" + host + "/api/v1.0/pgn"];
}

function looksLikePgn(text) {
  return /\[(Event|White|Site|Result)\s+"/.test(text) || /\b\d+\.\s*(?:[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8]|O-O)/.test(text);
}

async function fetchPgnOnce(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 1500);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) return null;
    const text = await r.text();
    if (!text || text.length > 2 * 1024 * 1024 || !looksLikePgn(text)) return null;
    return text;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function handlePgn(res) {
  const board = readConfigFile("board");
  if (!board.pgn || board.pgn.enabled === false) return sendJSON(res, 200, { ok: false, status: "disabled" });

  // The client cadence governs; still, never probe more than ~once a second.
  const now = Date.now();
  if (now - PGN_LAST_ATTEMPT >= 1000) {
    PGN_LAST_ATTEMPT = now;
    const list = pgnCandidates(board);
    const ordered = PGN_STICKY_URL && list.includes(PGN_STICKY_URL)
      ? [PGN_STICKY_URL, ...list.filter(u => u !== PGN_STICKY_URL)]
      : list;
    for (const url of ordered) {
      const text = await fetchPgnOnce(url);
      if (text !== null) {
        PGN_STICKY_URL = url;
        PGN_CACHE = { text, url, at: now };
        break;
      }
    }
  }

  if (!PGN_CACHE) return sendJSON(res, 200, { ok: false, status: "absent" });
  return sendJSON(res, 200, {
    ok: true,
    pgn: PGN_CACHE.text,
    source: PGN_CACHE.url,
    fetched_at: PGN_CACHE.at,
    stale: Date.now() - PGN_CACHE.at > Math.max(4000, (Number(board.pgn.poll_ms) || 6000) * 2),
  });
}

function handleApi(req, res, pathname) {
  // GET /api/config/hash — the display's cheap poll target.
  if (req.method === "GET" && pathname === "/api/config/hash") {
    return sendJSON(res, 200, { ok: true, hash: configHash() });
  }

  // GET /api/pgn — probe/relay the LiveChess game PGN (see PGN source above).
  if (req.method === "GET" && pathname === "/api/pgn") {
    handlePgn(res).catch(() => { try { sendError(res, 500, "pgn probe failed"); } catch { } });
    return;
  }

  // Display heartbeat: POST from the display page, GET from admin.
  if (pathname === "/api/status") {
    if (req.method === "POST") {
      return readBody(req, res, (buf) => {
        try {
          const parsed = JSON.parse(buf.toString("utf8"));
          if (!isPlainObject(parsed)) return sendError(res, 400, "status must be a JSON object");
          DISPLAY_STATUS = parsed;
          DISPLAY_STATUS_AT = Date.now();
          return sendJSON(res, 200, { ok: true });
        } catch {
          return sendError(res, 400, "invalid JSON");
        }
      });
    }
    if (req.method === "GET") {
      return sendJSON(res, 200, {
        ok: true,
        status: DISPLAY_STATUS,
        age_ms: DISPLAY_STATUS ? Date.now() - DISPLAY_STATUS_AT : null,
      });
    }
  }

  // GET /api/config — everything merged, plus the hash it corresponds to.
  if (req.method === "GET" && pathname === "/api/config") {
    return sendJSON(res, 200, { ok: true, hash: configHash(), config: readAllConfig() });
  }

  // POST /api/config/:name — replace one config file.
  let m = /^\/api\/config\/([a-z]+)$/.exec(pathname);
  if (req.method === "POST" && m) {
    const name = m[1];
    if (!CONFIG_NAMES.includes(name)) return sendError(res, 404, "unknown config: " + name);
    return readBody(req, res, (buf) => {
      let parsed;
      try {
        parsed = JSON.parse(buf.toString("utf8"));
      } catch {
        return sendError(res, 400, "invalid JSON");
      }
      if (!isPlainObject(parsed)) return sendError(res, 400, "config must be a JSON object");
      try {
        writeFileAtomic(path.join(CONFIG_DIR, name + ".json"), JSON.stringify(parsed, null, 2) + "\n");
      } catch (e) {
        console.warn(`[config] write ${name}.json failed: ${e.message}`);
        return sendError(res, 500, "write failed");
      }
      // Never log config contents — pairingsman.json carries the bearer token.
      console.log(`[config] ${name}.json written (${buf.length} bytes)`);
      return sendJSON(res, 200, { ok: true, hash: configHash() });
    });
  }

  // GET /api/assets/:kind — list files for the admin pickers.
  m = /^\/api\/assets\/([a-z]+)$/.exec(pathname);
  if (req.method === "GET" && m) {
    const kind = m[1];
    const exts = ASSET_KINDS[kind];
    if (!exts) return sendError(res, 404, "unknown asset kind: " + kind);
    const dir = path.join(ASSETS_DIR, kind);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      /* missing folder → empty list */
    }
    const files = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!exts.includes(ext)) continue;
      try {
        const st = fs.statSync(path.join(dir, e.name));
        files.push({ name: e.name, size: st.size, mtime: st.mtimeMs, url: `/assets/${kind}/${encodeURIComponent(e.name)}` });
      } catch { /* raced deletion — skip */ }
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    return sendJSON(res, 200, { ok: true, files });
  }

  // POST /api/asset — { kind, filename, data } (base64). Logos, photos, music.
  if (req.method === "POST" && pathname === "/api/asset") {
    return readBody(req, res, (buf) => {
      let body;
      try {
        body = JSON.parse(buf.toString("utf8"));
      } catch {
        return sendError(res, 400, "invalid JSON");
      }
      const { kind, filename, data } = body || {};
      if (!UPLOAD_KINDS.includes(kind)) return sendError(res, 400, "kind must be one of: " + UPLOAD_KINDS.join(", "));
      if (typeof filename !== "string" || !filename) return sendError(res, 400, "filename required");
      if (typeof data !== "string" || !data) return sendError(res, 400, "data (base64) required");

      // Sanitize: basename only, safe charset, extension whitelisted per kind.
      const exts = ASSET_KINDS[kind];
      const base = path.basename(filename).replace(/[^A-Za-z0-9._ -]/g, "_");
      const ext = path.extname(base).toLowerCase();
      if (!exts.includes(ext)) return sendError(res, 400, "extension must be one of: " + exts.join(", "));
      let bytes;
      try {
        bytes = Buffer.from(data, "base64");
      } catch {
        return sendError(res, 400, "invalid base64");
      }
      if (!bytes.length) return sendError(res, 400, "empty file");
      try {
        writeFileAtomic(path.join(ASSETS_DIR, kind, base), bytes);
      } catch (e) {
        console.warn(`[asset] write failed: ${e.message}`);
        return sendError(res, 500, "write failed");
      }
      console.log(`[asset] ${kind}/${base} written (${bytes.length} bytes)`);
      return sendJSON(res, 200, { ok: true, name: base, url: `/assets/${kind}/${encodeURIComponent(base)}` });
    }, ASSET_MAX_BODY);
  }

  // POST /api/asset/delete — { kind, name }. Music library only: the admin
  // page manages that folder wholesale; images stay hand-managed on disk.
  if (req.method === "POST" && pathname === "/api/asset/delete") {
    return readBody(req, res, (buf) => {
      let body;
      try {
        body = JSON.parse(buf.toString("utf8"));
      } catch {
        return sendError(res, 400, "invalid JSON");
      }
      const { kind, name } = body || {};
      if (!DELETE_KINDS.includes(kind)) return sendError(res, 400, "kind must be one of: " + DELETE_KINDS.join(", "));
      if (typeof name !== "string" || !name) return sendError(res, 400, "name required");
      const base = path.basename(name);
      const ext = path.extname(base).toLowerCase();
      if (base !== name || !ASSET_KINDS[kind].includes(ext)) return sendError(res, 400, "bad name");
      const file = path.join(ASSETS_DIR, kind, base);
      try {
        fs.unlinkSync(file);
      } catch (e) {
        if (e.code === "ENOENT") return sendError(res, 404, "no such file");
        console.warn(`[asset] delete failed: ${e.message}`);
        return sendError(res, 500, "delete failed");
      }
      console.log(`[asset] ${kind}/${base} deleted`);
      return sendJSON(res, 200, { ok: true });
    });
  }

  return sendError(res, 404, "no such endpoint");
}

/* ----------------------------------------------------------------- server */

const server = http.createServer((req, res) => {
  try {
    const pathname = (req.url || "/").split("?")[0];

    if (pathname.startsWith("/api/")) return handleApi(req, res, pathname);

    if (req.method !== "GET" && req.method !== "HEAD") return sendError(res, 405, "method not allowed");

    if (pathname === "/") return serveStatic(req, res, PUBLIC_DIR, "/display.html");
    if (pathname === "/favicon.ico") { res.writeHead(204); return res.end(); }
    if (pathname.startsWith("/assets/")) return serveStatic(req, res, ASSETS_DIR, pathname.slice("/assets".length));
    if (pathname.startsWith("/vendor/")) return serveStatic(req, res, VENDOR_DIR, pathname.slice("/vendor".length));
    return serveStatic(req, res, PUBLIC_DIR, pathname);
  } catch (e) {
    // The stream must never die because the server hiccuped.
    console.error("[server] request error:", e.message);
    try { sendError(res, 500, "internal error"); } catch { /* headers already sent */ }
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error(`  Either the overlay server is already running (check your other windows),`);
    console.error(`  or set a different port:  set SCC_PORT=8421  then run start-overlay.bat again.\n`);
  } else {
    console.error("[server] " + e.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("  SCC Broadcast Overlay server running (local only)");
  console.log("  ------------------------------------------------");
  console.log(`  Display (OBS browser source):  http://${HOST}:${PORT}/display.html`);
  console.log(`  Admin   (open in a browser):   http://${HOST}:${PORT}/admin.html`);
  console.log("");
  console.log("  Leave this window open while streaming. Ctrl+C to stop.");
  console.log("");
});
