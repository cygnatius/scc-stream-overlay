/* Headless test for the Pairingsman client's failure reporting
   (public/js/pairingsman.js). Loads the real module in a vm with a stubbed
   fetch and checks what admin is TOLD when the broadcast call fails:

     node tools/pairingsman-selftest.js .

   The case that matters (24 Oct 2026 meet): the configured key was a
   personal token (php artisan api:token). Pairingsman's broadcast routes
   take only an association token and answer 404 to anything else, so the
   overlay reported "not found or not visible to this token" for every
   entity and the real cause — the wrong KIND of token — was invisible. A
   personal token can read /api/user; an association token cannot. */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = process.argv[2] || ".";
let passed = 0, failed = 0;
function ok(name, cond) { console.log((cond ? "  PASS  " : "  FAIL  ") + name); cond ? passed++ : failed++; }

// What the fake Pairingsman answers, by URL suffix.
const routes = {};
const calls = [];
async function fetchStub(url, opts) {
  calls.push(url);
  const key = Object.keys(routes).find((k) => url.endsWith(k));
  const r = routes[key] || { status: 404, body: { message: "That no longer exists." } };
  return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body };
}

let onChange = null;
const store = { loaded: true, data: { pairingsman: { base_url: "https://pm.test", token: "8|abc", entity_type: "meeting", entity_id: 146, refresh_ms: 30000 } } };
const ctx = {
  window: {}, console, fetch: fetchStub,
  setTimeout: () => 0, clearTimeout() {},
  Date,
  Vue: { reactive: (o) => o },
};
ctx.window.SCC = { config: { onChange: (fn) => { onChange = fn; }, store } };
ctx.SCC = ctx.window.SCC;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, "public/js/pairingsman.js"), "utf8"), ctx);
const PM = ctx.SCC.pairingsman;

const tick = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 10; i++) await tick(); }
function reconfigure(patch) {
  Object.assign(store.data.pairingsman, patch);
  onChange();
}

(async () => {
  // A personal token: broadcast says 404, the identity route says 200.
  routes["/api/v1/broadcast/meetings/146"] = { status: 404, body: { message: "That no longer exists." } };
  routes["/api/user"] = { status: 200, body: { id: 1, name: "Operator" } };
  PM.init(store);
  await settle();
  ok("personal token on the broadcast API → status 'usertoken', not 'notfound'", PM.state.status === "usertoken");
  ok("…found with exactly one extra request, to /api/user", calls.filter((u) => u.endsWith("/api/user")).length === 1);
  ok("…and nothing is shown as pulled", PM.auto("event_title") === null);

  // An association token that cannot see this id: 404 on both.
  calls.length = 0;
  routes["/api/user"] = { status: 404, body: { message: "That no longer exists." } };
  reconfigure({ token: "9|assoc" });
  await settle();
  ok("association token, id not visible → 'notfound'", PM.state.status === "notfound");

  // The identity probe failing on the network is not evidence of a user token.
  calls.length = 0;
  routes["/api/user"] = null;
  ctx.fetch = async (url) => { if (url.endsWith("/api/user")) throw new Error("network"); return fetchStub(url); };
  reconfigure({ token: "10|assoc2" });
  await settle();
  ok("probe unreachable → still 'notfound' (no claim made)", PM.state.status === "notfound");
  ctx.fetch = fetchStub;

  // The right token: the payload lands and the status is live.
  routes["/api/v1/broadcast/meetings/146"] = { status: 200, body: { data: { event: { title: "Club meet" }, venue: { name: "Hall" } } } };
  reconfigure({ token: "11|good" });
  await settle();
  ok("association token with access → 'live' and the payload is adapted", PM.state.status === "live" && PM.auto("event_title") === "Club meet");

  // Revoked: 401 is 'denied', never confused with the token-kind case.
  routes["/api/v1/broadcast/meetings/146"] = { status: 401, body: { message: "Unauthenticated." } };
  routes["/api/user"] = { status: 200, body: {} };
  reconfigure({ token: "12|revoked" });
  await settle();
  ok("401 → 'denied'", PM.state.status === "denied");

  console.log("\n" + (failed ? "FAILURES: " + failed : "all pairingsman scenarios passing") + "  (" + passed + " passed)");
  process.exit(failed ? 1 : 0);
})();
