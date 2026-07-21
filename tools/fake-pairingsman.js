/* Fake Pairingsman broadcast API — DEV TOOL ONLY, never served by the overlay.
   Serves the composed broadcast payload the thin client is built against,
   with CORS open (the real Pairingsman must allow the overlay origin too).
   AUTHORITATIVE SHAPE: docs/operations/broadcast-api.md in the Pairingsman
   repo — when it lands, update this fake AND public/js/pairingsman.js's
   adaptPayload() together.

     node tools/fake-pairingsman.js         (listens on 127.0.0.1:8021)

   Auth: Authorization: Bearer test-token-123  (else 401)
   GET /api/v1/broadcast/{tournaments|meetings|pairings}/210 → { data: … }
   GET /_mode?m=full|nulls|notfound|denied    switch behaviour
   GET /_state                                request counter + mode        */
"use strict";
const http = require("http");

let mode = "full";
let hits = 0;

const FULL = {
  event: { title: "Fake Club Championship 2026" },
  venue: { name: "Fake Mechanics Institute" },
  schedule: { open: "2026-07-23T19:30:00+10:00", close: "2026-07-23T22:45:00+10:00" },
  table: { name: "", number: 1 },
  players: {
    white: { name: "Auto White", title: "", rating: 1701, wins: 4, draws: 1, losses: 2, photo_url: null },
    black: { name: "Auto Black", title: "CM", rating: 1888, wins: 1, draws: 0, losses: 4, photo_url: null },
  },
  result: { status: "white_win", label: "1-0", white_score: 1, black_score: 0, forfeit: false, recorded: true },
  feature_matches: [
    { surface: { name: "Board 1" }, white: { name: "Auto White" }, black: { name: "Auto Black" }, scheduled_start: "2026-07-23T19:45:00+10:00" },
    { surface: { name: "Board 2" }, white: { name: "C. Third" }, black: { name: "D. Fourth" }, scheduled_start: null },
  ],
  tournament_leaderboard: [
    { rank: 1, name: "Auto Black", score: "6" },
    { rank: 2, name: "Auto White", score: "4.5" },
    { rank: 3, name: "C. Third", score: "4" },
  ],
  meeting_leaderboard: [
    { rank: 1, name: "Auto White", score: "1" },
    { rank: 2, name: "Auto Black", score: "0" },
  ],
  concurrent_pairings: [
    { surface: { name: "Board 2" }, white: { name: "C. Third" }, black: { name: "D. Fourth" }, result: { label: null } },
    { surface: { name: "Board 3" }, white: { name: "E. Fifth" }, black: { name: "F. Sixth" }, result: { label: null } },
  ],
  results: [
    { white: { name: "G. Seventh" }, black: { name: "H. Eighth" }, result: { label: "0-1" } },
  ],
  next_meeting: { open: "2026-07-30T19:30:00+10:00", close: "2026-07-30T22:45:00+10:00", venue: { name: "Fake Mechanics Institute" } },
};

// Every key present, all null — the contract's "absent data" shape.
const NULLS = Object.fromEntries(Object.keys(FULL).map(k => [k, null]));

const server = http.createServer((req, res) => {
  const [p, q] = (req.url || "/").split("?");
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Accept, Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };
  const json = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, Object.assign({ "Content-Type": "application/json" }, cors));
    res.end(body);
  };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (p === "/_mode") { mode = new URLSearchParams(q).get("m") || "full"; return json(200, { mode }); }
  if (p === "/_state") return json(200, { mode, hits });

  const m = /^\/api\/v1\/broadcast\/(tournaments|meetings|pairings)\/(\w+)$/.exec(p);
  if (m) {
    hits++;
    if (mode === "denied") return json(401, { message: "Unauthenticated." });
    if ((req.headers.authorization || "") !== "Bearer test-token-123") return json(401, { message: "Unauthenticated." });
    if (mode === "notfound" || m[2] !== "210") return json(404, { message: "Not found." });
    return json(200, { data: mode === "nulls" ? NULLS : FULL });
  }
  json(404, { message: "Not found." });
});

server.listen(8021, "127.0.0.1", () => console.log("fake pairingsman on 127.0.0.1:8021 (token: test-token-123, entity id: 210)"));
