// Blocking rules and schedules.
//
// Replaces the extension's flat `blacklist` array. A row per pattern is what
// lets the dashboard attach a reason, a schedule and per-rule statistics —
// none of which an array of strings could carry.

import { get, all, run, transaction, now } from "../db/index.js";
import { badRequest, notFound, conflict } from "../lib/errors.js";
import { normalizeDomain } from "../lib/validate.js";

/** Hosts that must never be blockable. Mirrors FOCUSOS_NEVER_BLOCK in shared.js. */
export const NEVER_BLOCK = [
  "google.com", "gstatic.com", "googleapis.com", "googleusercontent.com",
  "duckduckgo.com", "bing.com", "brave.com", "startpage.com",
  "accounts.google.com", "chrome.google.com"
];

export const DEFAULT_SITES = [
  "facebook.com", "instagram.com", "twitter.com", "x.com",
  "youtube.com", "reddit.com", "tiktok.com", "netflix.com"
];

export const SHIELD_TYPES = ["youtube_zen", "twitter_clean", "reddit_clean"];

export function isNeverBlockable(domain) {
  const host = normalizeDomain(domain);
  if (!host) return true;
  return NEVER_BLOCK.some((item) => host === item || host.endsWith("." + item));
}

function bumpVersion(userId) {
  const stamp = now();
  const user = get("SELECT sync_version FROM users WHERE id = ?", [userId]);
  const next = (user?.sync_version ?? 0) + 1;
  run("UPDATE users SET sync_version = ?, updated_at = ? WHERE id = ?", [next, stamp, userId]);
  return next;
}

function shape(row) {
  return {
    id: row.id,
    pattern: row.pattern,
    kind: row.kind,
    shieldType: row.shield_type,
    enabled: !!row.enabled,
    scheduleId: row.schedule_id,
    note: row.note,
    source: row.source,
    createdAt: row.created_at
  };
}

/** Rules, each carrying how many times it actually fired in the last 7 days. */
export function listRules(userId) {
  const rows = all(
    `SELECT r.*,
            (SELECT COUNT(*) FROM block_events b
              WHERE b.user_id = r.user_id
                AND (b.domain = r.pattern OR b.domain LIKE '%.' || r.pattern)
                AND b.local_date >= date('now', '-7 day')) AS hits_7d
       FROM rules r
      WHERE r.user_id = ?
      ORDER BY r.kind, r.pattern`,
    [userId]
  );
  return rows.map((row) => Object.assign(shape(row), { hits7d: row.hits_7d || 0 }));
}

export function createRule(userId, input) {
  const pattern = normalizeDomain(input.pattern);
  if (!pattern) throw badRequest("Enter a domain.", { pattern: "Required." });
  if (input.kind !== "allow" && isNeverBlockable(pattern)) {
    throw badRequest("That host can't be blocked.", {
      pattern: "Search engines and browser infrastructure stay reachable so you can't lock yourself out."
    });
  }
  if (input.shieldType && !SHIELD_TYPES.includes(input.shieldType)) {
    throw badRequest("Unknown shield.", { shieldType: `Must be one of: ${SHIELD_TYPES.join(", ")}.` });
  }

  return transaction(() => {
    const stamp = now();
    const existing = get(
      "SELECT id FROM rules WHERE user_id = ? AND pattern = ? AND kind = ?",
      [userId, pattern, input.kind || "block"]
    );
    if (existing) throw conflict("rule_exists", `${pattern} is already on the list.`);

    const result = run(
      `INSERT INTO rules (user_id, pattern, kind, shield_type, enabled, schedule_id, note, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      [userId, pattern, input.kind || "block", input.shieldType || null,
       input.scheduleId || null, input.note || null, input.source || "user", stamp, stamp]
    );
    bumpVersion(userId);
    return shape(get("SELECT * FROM rules WHERE id = ?", [Number(result.lastInsertRowid)]));
  });
}

export function updateRule(userId, ruleId, patch) {
  return transaction(() => {
    const row = get("SELECT * FROM rules WHERE id = ? AND user_id = ?", [ruleId, userId]);
    if (!row) throw notFound("No such rule.");

    const next = {
      enabled: patch.enabled === undefined ? row.enabled : (patch.enabled ? 1 : 0),
      shield_type: patch.shieldType === undefined ? row.shield_type : (patch.shieldType || null),
      schedule_id: patch.scheduleId === undefined ? row.schedule_id : (patch.scheduleId || null),
      note: patch.note === undefined ? row.note : (patch.note || null),
      kind: patch.kind === undefined ? row.kind : patch.kind
    };
    if (next.shield_type && !SHIELD_TYPES.includes(next.shield_type)) {
      throw badRequest("Unknown shield.", { shieldType: `Must be one of: ${SHIELD_TYPES.join(", ")}.` });
    }
    if (next.schedule_id) {
      const schedule = get("SELECT id FROM schedules WHERE id = ? AND user_id = ?", [next.schedule_id, userId]);
      if (!schedule) throw badRequest("Unknown schedule.", { scheduleId: "No such schedule." });
    }

    run(
      `UPDATE rules SET enabled = ?, shield_type = ?, schedule_id = ?, note = ?, kind = ?, updated_at = ?
        WHERE id = ?`,
      [next.enabled, next.shield_type, next.schedule_id, next.note, next.kind, now(), ruleId]
    );
    bumpVersion(userId);
    return shape(get("SELECT * FROM rules WHERE id = ?", [ruleId]));
  });
}

export function deleteRule(userId, ruleId) {
  return transaction(() => {
    const row = get("SELECT id FROM rules WHERE id = ? AND user_id = ?", [ruleId, userId]);
    if (!row) throw notFound("No such rule.");
    run("DELETE FROM rules WHERE id = ?", [ruleId]);
    bumpVersion(userId);
    return { ok: true };
  });
}

/**
 * Bulk paste — the thing that is genuinely painful in a 400px popup.
 * Reports what it skipped and why, rather than silently dropping entries.
 */
export function bulkAdd(userId, text, kind = "block") {
  const tokens = String(text || "").split(/[\s,;\n]+/).filter(Boolean);
  const added = [];
  const skipped = [];
  const seen = new Set();

  transaction(() => {
    const stamp = now();
    for (const token of tokens) {
      const pattern = normalizeDomain(token);
      if (!pattern) { skipped.push({ pattern: token, reason: "Not a domain." }); continue; }
      if (seen.has(pattern)) { skipped.push({ pattern, reason: "Listed twice." }); continue; }
      seen.add(pattern);

      if (kind !== "allow" && isNeverBlockable(pattern)) {
        skipped.push({ pattern, reason: "Always reachable — search and browser infrastructure." });
        continue;
      }
      const existing = get("SELECT id FROM rules WHERE user_id = ? AND pattern = ? AND kind = ?",
        [userId, pattern, kind]);
      if (existing) { skipped.push({ pattern, reason: "Already on the list." }); continue; }

      run(
        `INSERT INTO rules (user_id, pattern, kind, enabled, source, created_at, updated_at)
         VALUES (?, ?, ?, 1, 'user', ?, ?)`,
        [userId, pattern, kind, stamp, stamp]
      );
      added.push(pattern);
    }
    if (added.length) bumpVersion(userId);
  });

  return { added, skipped };
}

/** Called once for a brand-new account so the extension has something to enforce. */
export function seedDefaultRules(userId) {
  const stamp = now();
  for (const pattern of DEFAULT_SITES) {
    run(
      `INSERT OR IGNORE INTO rules (user_id, pattern, kind, enabled, source, created_at, updated_at)
       VALUES (?, ?, 'block', 1, 'default', ?, ?)`,
      [userId, pattern, stamp, stamp]
    );
  }
}

// ---------------------------------------------------------------- schedules

function shapeSchedule(row) {
  return {
    id: row.id,
    name: row.name,
    daysMask: row.days_mask,
    startMin: row.start_min,
    endMin: row.end_min,
    enabled: !!row.enabled
  };
}

export function listSchedules(userId) {
  return all("SELECT * FROM schedules WHERE user_id = ? ORDER BY name", [userId]).map(shapeSchedule);
}

export function createSchedule(userId, input) {
  return transaction(() => {
    const stamp = now();
    const result = run(
      `INSERT INTO schedules (user_id, name, days_mask, start_min, end_min, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      [userId, input.name, input.daysMask ?? 127, input.startMin, input.endMin, stamp, stamp]
    );
    bumpVersion(userId);
    return shapeSchedule(get("SELECT * FROM schedules WHERE id = ?", [Number(result.lastInsertRowid)]));
  });
}

export function updateSchedule(userId, id, patch) {
  return transaction(() => {
    const row = get("SELECT * FROM schedules WHERE id = ? AND user_id = ?", [id, userId]);
    if (!row) throw notFound("No such schedule.");
    run(
      `UPDATE schedules SET name = ?, days_mask = ?, start_min = ?, end_min = ?, enabled = ?, updated_at = ?
        WHERE id = ?`,
      [patch.name ?? row.name, patch.daysMask ?? row.days_mask,
       patch.startMin ?? row.start_min, patch.endMin ?? row.end_min,
       patch.enabled === undefined ? row.enabled : (patch.enabled ? 1 : 0), now(), id]
    );
    bumpVersion(userId);
    return shapeSchedule(get("SELECT * FROM schedules WHERE id = ?", [id]));
  });
}

export function deleteSchedule(userId, id) {
  return transaction(() => {
    const row = get("SELECT id FROM schedules WHERE id = ? AND user_id = ?", [id, userId]);
    if (!row) throw notFound("No such schedule.");
    run("DELETE FROM schedules WHERE id = ?", [id]);
    bumpVersion(userId);
    return { ok: true };
  });
}
