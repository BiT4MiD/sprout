// Fast structural checks: routing, schema and the settings catalogue.
// The behavioural coverage lives in api.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRouter } from "../src/index.js";
import { readSchema } from "../src/db/migrate.js";
import { SETTINGS_CATALOGUE } from "../src/services/settings.service.js";

test("every documented endpoint is registered", () => {
  const paths = new Set(buildRouter().routes.map((r) => `${r.method} /${r.segments.join("/")}`));
  for (const expected of [
    "POST /api/auth/signup", "POST /api/auth/login", "POST /api/auth/logout",
    "GET /api/auth/me", "POST /api/auth/password",
    "POST /api/devices/pair-code", "POST /api/devices/redeem",
    "GET /api/devices", "DELETE /api/devices/:id",
    "GET /api/settings", "PATCH /api/settings",
    "POST /api/sync",
    "GET /api/stats/summary", "GET /api/stats/timeseries", "GET /api/stats/domains",
    "GET /api/stats/hourly", "GET /api/stats/sessions", "GET /api/stats/export",
    "GET /api/rules", "POST /api/rules", "POST /api/rules/bulk",
    "PATCH /api/rules/:id", "DELETE /api/rules/:id",
    "GET /api/schedules", "POST /api/schedules",
    "PATCH /api/schedules/:id", "DELETE /api/schedules/:id",
    "GET /api/account/audit", "POST /api/account/export", "DELETE /api/account"
  ]) {
    assert.ok(paths.has(expected), `missing route: ${expected}`);
  }
});

test("every guarded route actually has a guard", () => {
  const open = buildRouter().routes.filter((r) => !r.guard)
    .map((r) => `${r.method} /${r.segments.join("/")}`);
  // Only three endpoints may be reached without credentials.
  assert.deepEqual(open.sort(), [
    "GET /api/health",
    "POST /api/auth/login",
    "POST /api/auth/signup",
    "POST /api/devices/redeem"
  ].sort());
});

test("the schema declares every table the services use", () => {
  const sql = readSchema();
  for (const table of [
    "users", "sessions", "devices", "pairing_codes", "settings",
    "rules", "schedules", "usage_daily", "focus_sessions",
    "block_events", "tasks", "audit_log"
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), `missing table: ${table}`);
  }
});

test("the settings catalogue is internally consistent", () => {
  for (const [key, def] of Object.entries(SETTINGS_CATALOGUE)) {
    assert.ok(["account", "device"].includes(def.scope), `${key}: bad scope`);
    assert.ok(["popup", "dashboard", "both"].includes(def.home), `${key}: bad home`);
    assert.ok(def.default !== undefined, `${key}: no default`);
    if (def.type === "enum") {
      assert.ok(Array.isArray(def.values) && def.values.includes(def.default), `${key}: default not in values`);
    }
    if (def.type === "secret") {
      assert.equal(def.scope, "account", `${key}: a secret must be account-scoped`);
    }
  }
});

test("the popup keeps only the controls it should", () => {
  // The decluttering contract, enforced: anything marked home:"dashboard"
  // must not reappear in the popup by accident.
  const popupKeys = Object.entries(SETTINGS_CATALOGUE)
    .filter(([, d]) => d.home !== "dashboard").map(([k]) => k).sort();
  assert.deepEqual(popupKeys, [
    "appearance", "audioVolume", "blockMode", "floatingWidget",
    "hardcore", "pomodoro", "soundscapeId", "theme"
  ]);
});
