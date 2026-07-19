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
    // Six-slot model: left/centre/right, each whole or split top/bottom.
    // Availability is per scene; the game scene provides right_top/right_bottom
    // (the existing under-moves panel) unless its bottom strip is enabled.
    slots: {},
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
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

const IMAGE_EXT = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"];
const VIDEO_EXT = [".mp4", ".webm", ".ogv", ".mov"];
const ASSET_KINDS = { sponsors: IMAGE_EXT, players: IMAGE_EXT, video: VIDEO_EXT };
const UPLOAD_KINDS = ["sponsors", "players"];          // videos are placed manually

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
  // Fonts/images barely change and are large-ish: allow a short cache.
  const cache = isVideo || IMAGE_EXT.includes(ext) || ext === ".woff2" || ext === ".woff" || ext === ".ttf"
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

function readBody(req, res, cb) {
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_BODY) {
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

function handleApi(req, res, pathname) {
  // GET /api/config/hash — the display's cheap poll target.
  if (req.method === "GET" && pathname === "/api/config/hash") {
    return sendJSON(res, 200, { ok: true, hash: configHash() });
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

  // POST /api/asset — { kind, filename, data } (base64). Sponsor logos & player photos only.
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

      // Sanitize: basename only, safe charset, whitelisted image extension.
      const base = path.basename(filename).replace(/[^A-Za-z0-9._ -]/g, "_");
      const ext = path.extname(base).toLowerCase();
      if (!IMAGE_EXT.includes(ext)) return sendError(res, 400, "extension must be one of: " + IMAGE_EXT.join(", "));
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
