// Settings service.
//
// The catalogue below is the single source of truth for what a setting IS:
// its type, its default, its bounds, and crucially its SCOPE — whether it
// belongs to the account (same everywhere) or to one browser.
//
// PATCH /api/settings validates against this, so a typo can't create a dead
// key, and the extension can't push an account-scoped value.

/**
 * scope: 'account' — dashboard owns it, extension receives it
 *        'device'  — extension owns it, dashboard displays it read-only
 * home:  where the control is rendered. 'popup' keys stay in the extension
 *        UI; 'dashboard' keys move to the web app; 'both' appears in each.
 */
export const SETTINGS_CATALOGUE = {
  // ---- Session & goals -------------------------------------------------
  pomodoro:        { type: "int",  default: 25,  min: 1, max: 180, scope: "account", home: "both" },
  breakMinutes:    { type: "int",  default: 5,   min: 1, max: 60,  scope: "account", home: "dashboard" },
  dailyGoalMin:    { type: "int",  default: 120, min: 15, max: 720, scope: "account", home: "dashboard" },
  autoBreak:       { type: "bool", default: false, scope: "account", home: "dashboard" },
  hardcore:        { type: "bool", default: false, scope: "account", home: "both" },

  // ---- Blocking --------------------------------------------------------
  blockMode:       { type: "enum", default: "deep_work", scope: "account", home: "both",
                     values: ["deep_work", "always", "scheduled", "strict_focus", "zen_redirect", "whitelist"] },
  whitelist:       { type: "bool", default: false, scope: "account", home: "dashboard" },
  scheduleEnabled: { type: "bool", default: false, scope: "account", home: "dashboard" },
  mindfulPauseGate:{ type: "bool", default: true,  scope: "account", home: "dashboard" },

  // ---- Site shields ----------------------------------------------------
  ytHideShorts:    { type: "bool", default: false, scope: "account", home: "dashboard" },
  ytHideComments:  { type: "bool", default: false, scope: "account", home: "dashboard" },
  ytHideRecs:      { type: "bool", default: false, scope: "account", home: "dashboard" },
  ytAutoTheater:   { type: "bool", default: true,  scope: "account", home: "dashboard" },
  cleanTwitter:    { type: "bool", default: false, scope: "account", home: "dashboard" },
  cleanReddit:     { type: "bool", default: false, scope: "account", home: "dashboard" },

  // ---- AI --------------------------------------------------------------
  // The Gemini key is account-scoped and write-only over the API: GET
  // returns "hasApiKey": true and never the value itself.
  apiKey:          { type: "secret", default: "", scope: "account", home: "dashboard" },
  personality:     { type: "enum", default: "coach", scope: "account", home: "dashboard",
                     values: ["coach", "drill_sergeant", "zen_master", "data_analyst"] },

  // ---- Notifications ---------------------------------------------------
  chimeSession:    { type: "bool", default: true, scope: "device", home: "dashboard" },
  chimeBreak:      { type: "bool", default: true, scope: "device", home: "dashboard" },
  notifyDesktop:   { type: "bool", default: true, scope: "device", home: "dashboard" },

  // ---- Labs ------------------------------------------------------------
  betaMusicPlayer:  { type: "bool", default: false, scope: "account", home: "dashboard" },
  betaInPageDimmer: { type: "bool", default: false, scope: "account", home: "dashboard" },
  betaBreakCoach:   { type: "bool", default: false, scope: "account", home: "dashboard" },
  betaBadges:       { type: "bool", default: false, scope: "account", home: "dashboard" },
  autoMusic:        { type: "bool", default: false, scope: "account", home: "dashboard" },

  // ---- This browser only ----------------------------------------------
  theme:           { type: "enum", default: "sprout", scope: "device", home: "both",
                     values: ["sprout", "midnight", "ocean", "ember", "rose", "graphite"] },
  appearance:      { type: "enum", default: "system", scope: "device", home: "both",
                     values: ["system", "light", "dark"] },
  floatingWidget:  { type: "bool",  default: true, scope: "device", home: "popup" },
  audioVolume:     { type: "float", default: 0.6, min: 0, max: 1, scope: "device", home: "popup" },
  soundscapeId:    { type: "string", default: "yt_lofigirl", scope: "device", home: "popup" }
};


import { get, all, run, transaction, now } from "../db/index.js";
import { badRequest, forbidden } from "../lib/errors.js";

/** Every key with its default, for a brand-new account. */
export function defaults() {
  const out = {};
  for (const [key, def] of Object.entries(SETTINGS_CATALOGUE)) out[key] = def.default;
  return out;
}

export function isAccountScoped(key) {
  return SETTINGS_CATALOGUE[key]?.scope === "account";
}

/** Coerces and bounds one value against the catalogue. Throws on anything unknown. */
export function coerce(key, value) {
  const def = SETTINGS_CATALOGUE[key];
  if (!def) throw badRequest("Unknown setting.", { [key]: "Not a setting Sprout knows about." });

  switch (def.type) {
    case "bool":
      if (typeof value === "boolean") return value;
      if (value === "true" || value === 1 || value === "1") return true;
      if (value === "false" || value === 0 || value === "0") return false;
      throw badRequest("Invalid setting.", { [key]: "Must be true or false." });
    case "int": {
      const n = Number(value);
      if (!Number.isInteger(n)) throw badRequest("Invalid setting.", { [key]: "Must be a whole number." });
      if (def.min !== undefined && n < def.min) throw badRequest("Invalid setting.", { [key]: `Minimum is ${def.min}.` });
      if (def.max !== undefined && n > def.max) throw badRequest("Invalid setting.", { [key]: `Maximum is ${def.max}.` });
      return n;
    }
    case "float": {
      const n = Number(value);
      if (!Number.isFinite(n)) throw badRequest("Invalid setting.", { [key]: "Must be a number." });
      if (def.min !== undefined && n < def.min) throw badRequest("Invalid setting.", { [key]: `Minimum is ${def.min}.` });
      if (def.max !== undefined && n > def.max) throw badRequest("Invalid setting.", { [key]: `Maximum is ${def.max}.` });
      return n;
    }
    case "enum": {
      const v = String(value);
      if (!def.values.includes(v)) {
        throw badRequest("Invalid setting.", { [key]: `Must be one of: ${def.values.join(", ")}.` });
      }
      return v;
    }
    case "secret":
    case "string": {
      const v = String(value);
      if (v.length > 400) throw badRequest("Invalid setting.", { [key]: "Too long." });
      return v;
    }
    default:
      return value;
  }
}

function readRows(userId, deviceId) {
  return all(
    `SELECT key, value_json, scope, device_id FROM settings
      WHERE user_id = ? AND (device_id IS NULL OR device_id = ?)`,
    [userId, deviceId ?? -1]
  );
}

/**
 * Account rows, overlaid with this device's own overrides.
 *
 * `apiKey` never leaves the server as a value for a browser session — the
 * dashboard gets `hasApiKey: true` instead. Only the sync endpoint, over an
 * authenticated device token, receives the real key, because the extension
 * is what actually calls Gemini.
 */
export function getEffectiveSettings(userId, deviceId, { includeSecrets = false } = {}) {
  const merged = defaults();
  const rows = readRows(userId, deviceId);

  // Account rows first, then device rows, so a device override wins.
  for (const row of rows.filter((r) => r.device_id === null)) {
    if (SETTINGS_CATALOGUE[row.key]) merged[row.key] = JSON.parse(row.value_json);
  }
  for (const row of rows.filter((r) => r.device_id !== null)) {
    if (SETTINGS_CATALOGUE[row.key]) merged[row.key] = JSON.parse(row.value_json);
  }

  const out = {};
  for (const [key, def] of Object.entries(SETTINGS_CATALOGUE)) {
    if (def.type === "secret" && !includeSecrets) continue;
    out[key] = merged[key];
  }
  if (!includeSecrets) {
    out.hasApiKey = Boolean(merged.apiKey);
  }

  const user = get("SELECT sync_version FROM users WHERE id = ?", [userId]);
  return { version: user ? user.sync_version : 0, settings: out };
}

/** The catalogue as the dashboard needs it: scope and where each control lives. */
export function settingsMeta() {
  const scopes = {};
  const homes = {};
  for (const [key, def] of Object.entries(SETTINGS_CATALOGUE)) {
    scopes[key] = def.scope;
    homes[key] = def.home;
  }
  return { scopes, homes };
}

/**
 * Validates against the catalogue, writes only what actually changed, and
 * bumps users.sync_version once for the whole patch.
 *
 * `actor` is "session" (the dashboard) or "device" (the extension). A device
 * may only write device-scoped keys — otherwise two browsers would fight over
 * the block list, which is exactly what the scope split exists to prevent.
 */
export function patchSettings(userId, deviceId, patch, { actor = "session" } = {}) {
  const entries = Object.entries(patch || {});
  if (!entries.length) return getEffectiveSettings(userId, deviceId);

  return transaction(() => {
    const stamp = now();
    let changed = 0;

    const user = get("SELECT sync_version FROM users WHERE id = ?", [userId]);
    const nextVersion = (user?.sync_version ?? 0) + 1;

    for (const [key, raw] of entries) {
      const def = SETTINGS_CATALOGUE[key];
      if (!def) throw badRequest("Unknown setting.", { [key]: "Not a setting Sprout knows about." });

      if (actor === "device" && def.scope === "account") {
        throw forbidden(`"${key}" is managed from the dashboard.`);
      }
      if (def.scope === "device" && !deviceId && actor === "device") {
        throw badRequest("Device settings need a paired device.");
      }

      const value = coerce(key, raw);
      // Device-scoped values written from the dashboard have no device to
      // attach to, so they are stored at account level and act as the default
      // a newly paired browser inherits.
      const targetDevice = def.scope === "device" ? (deviceId ?? null) : null;

      const existing = get(
        `SELECT value_json FROM settings
          WHERE user_id = ? AND key = ? AND device_id IS ?`,
        [userId, key, targetDevice]
      );
      const encoded = JSON.stringify(value);
      if (existing && existing.value_json === encoded) continue;

      run(
        `INSERT INTO settings (user_id, device_id, key, value_json, scope, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, device_id, key)
         DO UPDATE SET value_json = excluded.value_json,
                       updated_at = excluded.updated_at,
                       version    = excluded.version`,
        [userId, targetDevice, key, encoded, def.scope, stamp, nextVersion]
      );
      changed++;
    }

    if (changed) {
      run("UPDATE users SET sync_version = ?, updated_at = ? WHERE id = ?", [nextVersion, stamp, userId]);
    }
    return getEffectiveSettings(userId, deviceId);
  });
}

/** Seeds a new account with the shipped defaults so sync has something to send. */
export function initialiseSettings(userId) {
  const stamp = now();
  for (const [key, def] of Object.entries(SETTINGS_CATALOGUE)) {
    if (def.type === "secret") continue;
    run(
      `INSERT OR IGNORE INTO settings (user_id, device_id, key, value_json, scope, updated_at, version)
       VALUES (?, NULL, ?, ?, ?, ?, 0)`,
      [userId, key, JSON.stringify(def.default), def.scope, stamp]
    );
  }
}
