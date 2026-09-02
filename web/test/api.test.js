// Integration tests over the real HTTP surface. No mocks: a server on an
// ephemeral port, an in-memory database, and fetch.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setDatabasePath, closeDb } from "../src/db/index.js";

setDatabasePath(":memory:");
const { ensureSchema } = await import("../src/db/migrate.js");
ensureSchema();
const { createServer, resetLimiters } = await import("../src/index.js");

let server, base;
const session = { cookie: "", csrf: "" };

before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  closeDb();
});

async function call(method, path, body, { auth = "session", token = null } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth === "session") {
    if (session.cookie) headers.cookie = session.cookie;
    if (session.csrf && method !== "GET") headers["x-csrf-token"] = session.csrf;
  } else if (auth === "device") {
    headers.authorization = `Bearer ${token}`;
  }
  const res = await fetch(base + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) session.cookie = setCookie.split(";")[0];
  let payload = null;
  try { payload = await res.json(); } catch { /* 204 */ }
  return { status: res.status, payload, res };
}

const EMAIL = "tester@sprout.local";
const PASSWORD = "a properly long passphrase";

test("signup creates an account with defaults and a session", async () => {
  resetLimiters();
  const { status, payload } = await call("POST", "/api/auth/signup", {
    email: EMAIL, password: PASSWORD, displayName: "Tester", timezone: "America/New_York"
  });
  assert.equal(status, 201);
  assert.equal(payload.user.email, EMAIL);
  assert.ok(payload.csrfToken);
  session.csrf = payload.csrfToken;

  const rules = await call("GET", "/api/rules");
  assert.equal(rules.payload.rules.length, 8, "ships with the default guarded sites");

  const settings = await call("GET", "/api/settings");
  assert.equal(settings.payload.settings.pomodoro, 25);
  assert.equal(settings.payload.settings.hasApiKey, false);
  assert.equal(settings.payload.settings.apiKey, undefined, "the key is never returned to a browser");
});

test("signup rejects weak passwords and duplicate emails without leaking existence", async () => {
  resetLimiters();
  const weak = await call("POST", "/api/auth/signup", { email: "x@y.zz", password: "short" });
  assert.equal(weak.status, 400);
  assert.match(weak.payload.error.fields.password, /10 characters/);

  const dupe = await call("POST", "/api/auth/signup", { email: EMAIL, password: "another long passphrase" });
  assert.equal(dupe.status, 409);
  assert.equal(dupe.payload.error.code, "email_taken");
  assert.doesNotMatch(dupe.payload.error.message, /already|exists|registered/i,
    "the message must not confirm the address is in use");
});

test("login is rejected for a bad password and rate limited", async () => {
  resetLimiters();
  const saved = session.cookie;
  session.cookie = "";
  for (let i = 0; i < 5; i++) {
    const bad = await call("POST", "/api/auth/login", { email: EMAIL, password: "wrong wrong wrong" });
    assert.equal(bad.status, 401);
    assert.equal(bad.payload.error.code, "invalid_credentials");
  }
  const limited = await call("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD });
  assert.equal(limited.status, 429, "the 6th attempt in the window is refused");
  assert.ok(limited.payload.error.retry_after_ms > 0);

  resetLimiters();
  const good = await call("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD });
  assert.equal(good.status, 200);
  session.csrf = good.payload.csrfToken;
  assert.ok(session.cookie !== saved);
});

test("a write without the CSRF token is refused even with a valid cookie", async () => {
  const res = await fetch(base + "/api/settings", {
    method: "PATCH",
    headers: { cookie: session.cookie, "content-type": "application/json" },
    body: JSON.stringify({ pomodoro: 30 })
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, "csrf_failed");
});

test("settings validate against the catalogue", async () => {
  const ok = await call("PATCH", "/api/settings", { pomodoro: 45, dailyGoalMin: 180 });
  assert.equal(ok.status, 200);
  assert.equal(ok.payload.settings.pomodoro, 45);

  const tooBig = await call("PATCH", "/api/settings", { pomodoro: 9999 });
  assert.equal(tooBig.status, 400);
  assert.match(tooBig.payload.error.fields.pomodoro, /Maximum is 180/);

  const unknown = await call("PATCH", "/api/settings", { notARealSetting: true });
  assert.equal(unknown.status, 400, "a typo must not silently create a dead key");
});

test("bulk add normalises, de-duplicates and refuses never-blockable hosts", async () => {
  const { payload } = await call("POST", "/api/rules/bulk", {
    patterns: "https://www.NEWS.ycombinator.com/\ngoogle.com\nreddit.com\nnews.ycombinator.com"
  });
  assert.deepEqual(payload.added, ["news.ycombinator.com"]);
  const reasons = Object.fromEntries(payload.skipped.map((s) => [s.pattern, s.reason]));
  assert.match(reasons["google.com"], /Always reachable/);
  assert.match(reasons["reddit.com"], /Already on the list/);
  assert.match(reasons["news.ycombinator.com"], /Listed twice/);
});

test("pairing: one-time code, then a device token", async (t) => {
  const { payload: codePayload } = await call("POST", "/api/devices/pair-code");
  assert.match(codePayload.code, /^[0-9A-Z]{8}$/);
  assert.ok(codePayload.expiresAt > Date.now());

  const redeemed = await call("POST", "/api/devices/redeem", {
    code: codePayload.code, name: "Chrome on test", platform: "Linux", extensionVersion: "1.3.0"
  }, { auth: "none" });
  assert.equal(redeemed.status, 201);
  assert.match(redeemed.payload.token, /^spr_dev_/);
  t.diagnostic("device token issued");

  const replay = await call("POST", "/api/devices/redeem", { code: codePayload.code }, { auth: "none" });
  assert.equal(replay.status, 410, "a code cannot be redeemed twice");

  const devices = await call("GET", "/api/devices");
  assert.equal(devices.payload.devices.length, 1);
  assert.equal(devices.payload.devices[0].extensionVersion, "1.3.0");

  globalThis.__token = redeemed.payload.token;
});

test("sync: push is idempotent and usage is MAX-merged", async () => {
  const token = globalThis.__token;
  const push = {
    usage: [{ localDate: "2026-09-01", domain: "reddit.com", seconds: 600, category: "distracting" }],
    sessions: [{ clientUuid: "sess-1", localDate: "2026-09-01", startedAt: Date.parse("2026-09-01T10:00:00Z"),
                 endedAt: Date.parse("2026-09-01T10:25:00Z"), plannedMin: 25, actualSeconds: 1500,
                 intention: "Write the tests", outcome: "accomplished", alignmentScore: 100 }],
    blocks: [{ clientUuid: "blk-1", domain: "reddit.com", localDate: "2026-09-01", localHour: 14,
               occurredAt: Date.parse("2026-09-01T14:10:00Z") }],
    deviceSettings: { theme: "ocean", appearance: "dark" }
  };

  const first = await call("POST", "/api/sync", { sinceVersion: -1, timezone: "America/New_York", push },
    { auth: "device", token });
  assert.equal(first.status, 200);
  assert.equal(first.payload.accepted.sessions, 1);
  assert.equal(first.payload.changed, true);
  assert.ok(first.payload.rules.length >= 8);
  assert.ok("apiKey" in first.payload.settings, "the extension does get the real key");

  // Exactly the same payload again — nothing may double-count.
  await call("POST", "/api/sync", { sinceVersion: first.payload.version, push }, { auth: "device", token });
  const summary = await call("GET", "/api/stats/summary?range=30d");
  assert.equal(summary.payload.sessions, 1, "a replayed session is not counted twice");
  assert.equal(summary.payload.blocks, 1, "a replayed block is not counted twice");
  assert.equal(summary.payload.categories.distracting, 600, "usage is absolute, not additive");

  // A smaller number for the same day must not erase progress.
  await call("POST", "/api/sync", {
    sinceVersion: first.payload.version,
    push: { usage: [{ localDate: "2026-09-01", domain: "reddit.com", seconds: 100, category: "distracting" }] }
  }, { auth: "device", token });
  const after = await call("GET", "/api/stats/summary?range=30d");
  assert.equal(after.payload.categories.distracting, 600, "MAX-merge keeps the larger total");
});

test("sync short-circuits when the client is already current", async () => {
  const token = globalThis.__token;
  const first = await call("POST", "/api/sync", { sinceVersion: -1 }, { auth: "device", token });
  const second = await call("POST", "/api/sync", { sinceVersion: first.payload.version }, { auth: "device", token });
  assert.equal(second.payload.changed, false);
  assert.equal(second.payload.settings, undefined);
  assert.ok(JSON.stringify(second.payload).length < 200, "the common case is a tiny response");
});

test("a device may not write account-scoped settings", async () => {
  const token = globalThis.__token;
  const before = await call("GET", "/api/settings");
  await call("POST", "/api/sync", {
    sinceVersion: -1, push: { deviceSettings: { pomodoro: 90, theme: "rose" } }
  }, { auth: "device", token });
  const after = await call("GET", "/api/settings");
  assert.equal(after.payload.settings.pomodoro, before.payload.settings.pomodoro,
    "an account-scoped key sent by a device is ignored");
});

test("stats answer questions the popup could not", async () => {
  const hourly = await call("GET", "/api/stats/hourly?range=30d");
  assert.equal(hourly.payload.hours.length, 24);
  assert.equal(hourly.payload.peakDistractionHour, 14);

  const domains = await call("GET", "/api/stats/domains?range=30d");
  const reddit = domains.payload.domains.find((d) => d.domain === "reddit.com");
  assert.equal(reddit.category, "distracting");
  assert.equal(reddit.blocked, true, "the domain table knows it is already guarded");

  const sessions = await call("GET", "/api/stats/sessions?range=30d");
  assert.equal(sessions.payload.sessions[0].intention, "Write the tests");

  const csv = await fetch(base + "/api/stats/export?format=csv&range=all", { headers: { cookie: session.cookie } });
  assert.match(csv.headers.get("content-disposition"), /attachment/);
  assert.match(await csv.text(), /date,domain,seconds,category/);
});

test("revoking a device kills its token immediately", async () => {
  const token = globalThis.__token;
  const devices = await call("GET", "/api/devices");
  await call("DELETE", `/api/devices/${devices.payload.devices[0].id}`);

  const refused = await call("POST", "/api/sync", { sinceVersion: -1 }, { auth: "device", token });
  assert.equal(refused.status, 401);
  assert.equal(refused.payload.error.code, "invalid_token",
    "the extension treats exactly this code as 'forget the pairing'");
});

test("another account's data is invisible", async () => {
  resetLimiters();
  const mine = session.cookie, myCsrf = session.csrf;
  session.cookie = ""; session.csrf = "";

  const other = await call("POST", "/api/auth/signup", {
    email: "second@sprout.local", password: "a completely unrelated phrase"
  });
  assert.equal(other.status, 201, JSON.stringify(other.payload));
  session.csrf = other.payload.csrfToken;

  const rules = await call("GET", "/api/rules");
  assert.ok(!rules.payload.rules.some((r) => r.pattern === "news.ycombinator.com"),
    "a new account does not see the first account's rules");
  const summary = await call("GET", "/api/stats/summary?range=30d");
  assert.equal(summary.payload.sessions, 0);

  session.cookie = mine; session.csrf = myCsrf;
});

test("the audit log records what happened", async () => {
  const { status, payload } = await call("GET", "/api/account/audit");
  assert.equal(status, 200);
  const actions = payload.entries.map((e) => e.action);
  assert.ok(actions.includes("device.paired"));
  assert.ok(actions.includes("device.revoked"));
  assert.ok(actions.includes("login.failed"));
});
