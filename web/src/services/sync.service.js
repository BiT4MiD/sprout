// The sync endpoint's engine. See docs/API.md → "Sync" for the protocol.
//
// The five rules the implementation honours:
//   1. Push is idempotent — clientUuid keys every event.
//   2. Usage is absolute, not a delta — MAX(existing, incoming) self-heals.
//   3. Config flows one way, server wins.
//   4. Device-scoped settings flow the other way.
//   5. sinceVersion short-circuits the common case to a few hundred bytes.

import { get, all, run, transaction, now } from "../db/index.js";
import { SETTINGS_CATALOGUE, getEffectiveSettings } from "./settings.service.js";
import { normalizeDomain, isLocalDate } from "../lib/validate.js";

const CATEGORIES = new Set(["productive", "research", "neutral", "distracting"]);
const OUTCOMES = new Set(["accomplished", "partially", "derailed", "abandoned"]);

const LIMITS = { usage: 2000, sessions: 500, blocks: 2000, tasks: 500 };

/**
 * @returns {{ accepted: object, versionBumped: boolean }}
 * Runs in one transaction so a partial push can never leave half a sprint.
 */
export function applyPush(userId, deviceId, push) {
  if (!push || typeof push !== "object") return { accepted: {}, versionBumped: false };

  return transaction(() => {
    const stamp = now();
    const accepted = { usage: 0, sessions: 0, blocks: 0, tasks: 0, deviceSettings: 0 };

    // --- 1. Usage: absolute daily totals, MAX-merged ---------------------
    for (const row of (push.usage || []).slice(0, LIMITS.usage)) {
      const domain = normalizeDomain(row?.domain);
      const seconds = Math.max(0, Math.floor(Number(row?.seconds) || 0));
      if (!domain || !isLocalDate(row?.localDate) || !seconds) continue;
      const category = CATEGORIES.has(row.category) ? row.category : "neutral";

      run(
        `INSERT INTO usage_daily (user_id, device_id, local_date, domain, seconds, category, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, local_date, domain, device_id)
         DO UPDATE SET seconds    = MAX(usage_daily.seconds, excluded.seconds),
                       category   = excluded.category,
                       updated_at = excluded.updated_at`,
        [userId, deviceId, row.localDate, domain, seconds, category, stamp]
      );
      accepted.usage++;
    }

    // --- 2. Focus sessions: upsert on clientUuid -------------------------
    for (const row of (push.sessions || []).slice(0, LIMITS.sessions)) {
      if (!row?.clientUuid || !isLocalDate(row?.localDate) || !row?.startedAt) continue;
      const outcome = OUTCOMES.has(row.outcome) ? row.outcome : null;

      run(
        `INSERT INTO focus_sessions
           (user_id, device_id, client_uuid, local_date, started_at, ended_at,
            planned_min, actual_seconds, intention, outcome, alignment_score)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, client_uuid)
         DO UPDATE SET ended_at        = COALESCE(excluded.ended_at, focus_sessions.ended_at),
                       actual_seconds  = MAX(focus_sessions.actual_seconds, excluded.actual_seconds),
                       intention       = COALESCE(excluded.intention, focus_sessions.intention),
                       outcome         = COALESCE(excluded.outcome, focus_sessions.outcome),
                       alignment_score = COALESCE(excluded.alignment_score, focus_sessions.alignment_score)`,
        [userId, deviceId, String(row.clientUuid).slice(0, 64), row.localDate,
         Math.floor(row.startedAt), row.endedAt ? Math.floor(row.endedAt) : null,
         Math.max(1, Math.floor(Number(row.plannedMin) || 25)),
         Math.max(0, Math.floor(Number(row.actualSeconds) || 0)),
         row.intention ? String(row.intention).slice(0, 300) : null,
         outcome,
         row.alignmentScore == null ? null : Math.max(0, Math.min(100, Math.floor(row.alignmentScore)))]
      );
      accepted.sessions++;
    }

    // --- 3. Block events: insert-once ------------------------------------
    for (const row of (push.blocks || []).slice(0, LIMITS.blocks)) {
      const domain = normalizeDomain(row?.domain);
      if (!row?.clientUuid || !domain || !isLocalDate(row?.localDate)) continue;
      const hour = Math.max(0, Math.min(23, Math.floor(Number(row.localHour) || 0)));

      run(
        `INSERT OR IGNORE INTO block_events
           (user_id, device_id, client_uuid, domain, local_date, local_hour, occurred_at, outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, deviceId, String(row.clientUuid).slice(0, 64), domain, row.localDate, hour,
         Math.floor(row.occurredAt || stamp),
         ["blocked", "hall_pass", "proceeded"].includes(row.outcome) ? row.outcome : "blocked"]
      );
      accepted.blocks++;
    }

    // --- 4. Tasks: last write wins ---------------------------------------
    for (const row of (push.tasks || []).slice(0, LIMITS.tasks)) {
      if (!row?.clientUuid || typeof row.text !== "string") continue;
      run(
        `INSERT INTO tasks (user_id, client_uuid, text, done, sort_order, created_at, completed_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, client_uuid)
         DO UPDATE SET text = excluded.text, done = excluded.done,
                       sort_order = excluded.sort_order,
                       completed_at = excluded.completed_at,
                       deleted_at = excluded.deleted_at`,
        [userId, String(row.clientUuid).slice(0, 64), row.text.slice(0, 300),
         row.done ? 1 : 0, Math.floor(Number(row.sortOrder) || 0),
         Math.floor(row.createdAt || stamp),
         row.completedAt ? Math.floor(row.completedAt) : null,
         row.deletedAt ? Math.floor(row.deletedAt) : null]
      );
      accepted.tasks++;
    }

    // --- 5. Device-scoped settings ---------------------------------------
    // Telemetry deliberately does NOT bump sync_version; only a setting does.
    // Otherwise every browser would re-download the whole config every tick.
    let versionBumped = false;
    const deviceSettings = push.deviceSettings || {};
    const pending = [];
    for (const [key, value] of Object.entries(deviceSettings)) {
      const def = SETTINGS_CATALOGUE[key];
      if (!def || def.scope !== "device") continue;   // silently ignore, never 400 a sync
      pending.push([key, value, def]);
    }

    if (pending.length && deviceId) {
      const user = get("SELECT sync_version FROM users WHERE id = ?", [userId]);
      const nextVersion = (user?.sync_version ?? 0) + 1;
      let wrote = 0;

      for (const [key, value, def] of pending) {
        const encoded = JSON.stringify(value);
        const existing = get(
          "SELECT value_json FROM settings WHERE user_id = ? AND device_id IS ? AND key = ?",
          [userId, deviceId, key]
        );
        if (existing && existing.value_json === encoded) continue;
        run(
          `INSERT INTO settings (user_id, device_id, key, value_json, scope, updated_at, version)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, device_id, key)
           DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
          [userId, deviceId, key, encoded, def.scope, stamp, nextVersion]
        );
        wrote++;
      }
      if (wrote) {
        accepted.deviceSettings = wrote;
        // A device's own preference is not news to any other device, so the
        // shared version stays put — the write is recorded, nothing re-pulls.
        versionBumped = false;
      }
    }

    return { accepted, versionBumped };
  });
}

/**
 * @returns {{ version, changed, settings?, rules?, schedules?, tasks? }}
 * When sinceVersion matches, returns only { version, changed:false }.
 */
export function buildPull(userId, deviceId, sinceVersion) {
  const user = get("SELECT sync_version FROM users WHERE id = ?", [userId]);
  const version = user?.sync_version ?? 0;

  if (Number(sinceVersion) === version) {
    return { version, changed: false };
  }

  const { settings } = getEffectiveSettings(userId, deviceId, { includeSecrets: true });

  const rules = all(
    `SELECT pattern, kind, shield_type, enabled, schedule_id
       FROM rules WHERE user_id = ? AND enabled = 1`,
    [userId]
  ).map((r) => ({
    pattern: r.pattern,
    kind: r.kind,
    shieldType: r.shield_type,
    enabled: !!r.enabled,
    scheduleId: r.schedule_id
  }));

  const schedules = all(
    "SELECT id, name, days_mask, start_min, end_min, enabled FROM schedules WHERE user_id = ? AND enabled = 1",
    [userId]
  ).map((s) => ({
    id: s.id, name: s.name, daysMask: s.days_mask,
    startMin: s.start_min, endMin: s.end_min, enabled: !!s.enabled
  }));

  const tasks = all(
    "SELECT client_uuid, text, done, sort_order FROM tasks WHERE user_id = ? AND deleted_at IS NULL ORDER BY sort_order",
    [userId]
  ).map((t) => ({ clientUuid: t.client_uuid, text: t.text, done: !!t.done, sortOrder: t.sort_order }));

  return { version, changed: true, settings, rules, schedules, tasks };
}

/** One round trip: push, then pull, then record where this device got to. */
export function sync(userId, deviceId, body) {
  const pushResult = applyPush(userId, deviceId, body?.push);
  const pull = buildPull(userId, deviceId, body?.sinceVersion ?? -1);

  run("UPDATE devices SET last_sync_at = ?, last_sync_version = ? WHERE id = ?",
    [now(), pull.version, deviceId]);

  return Object.assign({ accepted: pushResult.accepted, serverTime: now() }, pull);
}
