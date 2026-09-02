// Analytics. Everything here is a SQL aggregate over usage_daily,
// focus_sessions and block_events.
//
// This is what the popup structurally could not do: the extension keeps usage
// as one opaque `timeStats[dateString][domain]` blob with no query language,
// so "which hour do I lose to Reddit" was unanswerable. Here it is a GROUP BY.

import { get, all } from "../db/index.js";
import { localDateIn, addDays, daysBetween } from "../lib/validate.js";

const RANGE_DAYS = { "24h": 1, "7d": 7, "30d": 30, "year": 365 };

/**
 * Resolves a range name to { start, end, prevStart, prevEnd, days } as local
 * calendar dates, so "last 7 days" means the user's days, not UTC's.
 */
export function rangeToDates(range, timezone, at = Date.now()) {
  const today = localDateIn(timezone || "UTC", at);

  if (range === "all") {
    return { start: "0000-01-01", end: today, prevStart: null, prevEnd: null, days: null };
  }
  const days = RANGE_DAYS[range] ?? 7;
  const start = addDays(today, -(days - 1));
  return {
    start,
    end: today,
    prevStart: addDays(start, -days),
    prevEnd: addDays(start, -1),
    days
  };
}

function windowTotals(userId, start, end) {
  const focus = get(
    `SELECT COALESCE(SUM(actual_seconds), 0) AS seconds,
            COUNT(*) AS sessions,
            SUM(CASE WHEN outcome IS NOT NULL AND outcome != 'abandoned' THEN 1 ELSE 0 END) AS completed
       FROM focus_sessions
      WHERE user_id = ? AND local_date BETWEEN ? AND ?`,
    [userId, start, end]
  );
  const blocks = get(
    `SELECT COUNT(*) AS n FROM block_events
      WHERE user_id = ? AND local_date BETWEEN ? AND ?`,
    [userId, start, end]
  );
  const categories = all(
    `SELECT category, COALESCE(SUM(seconds), 0) AS seconds
       FROM usage_daily
      WHERE user_id = ? AND local_date BETWEEN ? AND ?
      GROUP BY category`,
    [userId, start, end]
  );

  const byCategory = { productive: 0, research: 0, neutral: 0, distracting: 0 };
  for (const row of categories) byCategory[row.category] = row.seconds;

  return {
    focusSeconds: focus?.seconds || 0,
    sessions: focus?.sessions || 0,
    sessionsCompleted: focus?.completed || 0,
    blocks: blocks?.n || 0,
    categories: byCategory
  };
}

function pctDelta(current, previous) {
  if (!previous) return current ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/** Headline numbers, each with the equivalent for the preceding window. */
export function summary(userId, range, timezone) {
  const window = rangeToDates(range, timezone);
  const current = windowTotals(userId, window.start, window.end);
  const previous = window.prevStart
    ? windowTotals(userId, window.prevStart, window.prevEnd)
    : { focusSeconds: 0, sessions: 0, blocks: 0 };

  const goalRow = get(
    `SELECT value_json FROM settings WHERE user_id = ? AND key = 'dailyGoalMin' AND device_id IS NULL`,
    [userId]
  );
  const goalMinutes = goalRow ? JSON.parse(goalRow.value_json) : 120;

  const goalDays = all(
    `SELECT local_date, SUM(actual_seconds) AS seconds
       FROM focus_sessions
      WHERE user_id = ? AND local_date BETWEEN ? AND ?
      GROUP BY local_date`,
    [userId, window.start, window.end]
  );
  const goalHitDays = goalDays.filter((d) => d.seconds >= goalMinutes * 60).length;

  const streak = streaks(userId, timezone, goalMinutes);

  return {
    range,
    focusSeconds: current.focusSeconds,
    focusSecondsPrev: previous.focusSeconds,
    focusDeltaPct: pctDelta(current.focusSeconds, previous.focusSeconds),
    sessions: current.sessions,
    sessionsPrev: previous.sessions,
    sessionsDeltaPct: pctDelta(current.sessions, previous.sessions),
    sessionsCompleted: current.sessionsCompleted,
    completionRate: current.sessions ? Math.round((current.sessionsCompleted / current.sessions) * 100) / 100 : 0,
    blocks: current.blocks,
    blocksPrev: previous.blocks,
    blocksDeltaPct: pctDelta(current.blocks, previous.blocks),
    streak: streak.current,
    longestStreak: streak.longest,
    goalMinutes,
    goalHitDays,
    goalDays: window.days || goalDays.length,
    categories: current.categories
  };
}

/** Per-day (or per-hour) buckets, zero-filled so charts have no gaps. */
export function timeseries(userId, range, bucket, timezone) {
  const window = rangeToDates(range, timezone);

  if (bucket === "hour") {
    const rows = all(
      `SELECT local_hour AS hour, COUNT(*) AS blocks
         FROM block_events
        WHERE user_id = ? AND local_date BETWEEN ? AND ?
        GROUP BY local_hour`,
      [userId, window.start, window.end]
    );
    const byHour = new Map(rows.map((r) => [r.hour, r.blocks]));
    return {
      bucket: "hour",
      points: Array.from({ length: 24 }, (_, hour) => ({ hour, blocks: byHour.get(hour) || 0 }))
    };
  }

  const focus = all(
    `SELECT local_date AS date, SUM(actual_seconds) AS seconds
       FROM focus_sessions WHERE user_id = ? AND local_date BETWEEN ? AND ?
      GROUP BY local_date`,
    [userId, window.start, window.end]
  );
  const distracting = all(
    `SELECT local_date AS date, SUM(seconds) AS seconds
       FROM usage_daily
      WHERE user_id = ? AND category = 'distracting' AND local_date BETWEEN ? AND ?
      GROUP BY local_date`,
    [userId, window.start, window.end]
  );
  const blocks = all(
    `SELECT local_date AS date, COUNT(*) AS n
       FROM block_events WHERE user_id = ? AND local_date BETWEEN ? AND ?
      GROUP BY local_date`,
    [userId, window.start, window.end]
  );

  const focusBy = new Map(focus.map((r) => [r.date, r.seconds]));
  const distractBy = new Map(distracting.map((r) => [r.date, r.seconds]));
  const blocksBy = new Map(blocks.map((r) => [r.date, r.n]));

  // "all" has no fixed length; span from the first day with data.
  let start = window.start;
  if (range === "all") {
    const first = get(
      `SELECT MIN(d) AS d FROM (
         SELECT MIN(local_date) AS d FROM usage_daily WHERE user_id = ?
         UNION SELECT MIN(local_date) FROM focus_sessions WHERE user_id = ?)`,
      [userId, userId]
    );
    start = first?.d || window.end;
  }

  const span = Math.max(0, daysBetween(start, window.end));
  const points = [];
  for (let i = 0; i <= span && i < 800; i++) {
    const date = addDays(start, i);
    points.push({
      date,
      focusSeconds: focusBy.get(date) || 0,
      distractingSeconds: distractBy.get(date) || 0,
      blocks: blocksBy.get(date) || 0
    });
  }
  return { bucket: "day", points };
}

/** Top domains with share of total and change against the previous window. */
export function domains(userId, range, { limit = 50, category = null } = {}, timezone) {
  const window = rangeToDates(range, timezone);
  const params = [userId, window.start, window.end];
  let filter = "";
  if (category) { filter = "AND category = ?"; params.push(category); }

  const rows = all(
    `SELECT domain, SUM(seconds) AS seconds, MAX(category) AS category
       FROM usage_daily
      WHERE user_id = ? AND local_date BETWEEN ? AND ? ${filter}
      GROUP BY domain ORDER BY seconds DESC LIMIT ?`,
    [...params, Math.min(Number(limit) || 50, 500)]
  );

  const total = rows.reduce((sum, r) => sum + r.seconds, 0) || 1;

  const prev = window.prevStart
    ? new Map(all(
        `SELECT domain, SUM(seconds) AS seconds FROM usage_daily
          WHERE user_id = ? AND local_date BETWEEN ? AND ? GROUP BY domain`,
        [userId, window.prevStart, window.prevEnd]
      ).map((r) => [r.domain, r.seconds]))
    : new Map();

  const guarded = new Set(
    all("SELECT pattern FROM rules WHERE user_id = ? AND kind = 'block' AND enabled = 1", [userId])
      .map((r) => r.pattern)
  );

  return {
    total,
    domains: rows.map((r) => ({
      domain: r.domain,
      seconds: r.seconds,
      category: r.category,
      sharePct: Math.round((r.seconds / total) * 1000) / 10,
      trendPct: pctDelta(r.seconds, prev.get(r.domain) || 0),
      blocked: guarded.has(r.domain)
    }))
  };
}

/**
 * Focus and distraction by hour of day.
 *
 * The extension guesses a "peak distraction hour" from browser history; this
 * is the measured version, from events it actually recorded.
 */
export function hourly(userId, range, timezone) {
  const window = rangeToDates(range, timezone);

  const focusRows = all(
    `SELECT CAST(strftime('%H', started_at / 1000, 'unixepoch') AS INTEGER) AS hour,
            SUM(actual_seconds) AS seconds, COUNT(*) AS sessions
       FROM focus_sessions
      WHERE user_id = ? AND local_date BETWEEN ? AND ?
      GROUP BY hour`,
    [userId, window.start, window.end]
  );
  const blockRows = all(
    `SELECT local_hour AS hour, COUNT(*) AS n
       FROM block_events WHERE user_id = ? AND local_date BETWEEN ? AND ?
      GROUP BY local_hour`,
    [userId, window.start, window.end]
  );

  const focusBy = new Map(focusRows.map((r) => [r.hour, r]));
  const blockBy = new Map(blockRows.map((r) => [r.hour, r.n]));

  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    focusSeconds: focusBy.get(hour)?.seconds || 0,
    sessions: focusBy.get(hour)?.sessions || 0,
    distractionEvents: blockBy.get(hour) || 0
  }));

  const bestFocus = hours.reduce((a, b) => (b.focusSeconds > a.focusSeconds ? b : a), hours[0]);
  const worstHour = hours.reduce((a, b) => (b.distractionEvents > a.distractionEvents ? b : a), hours[0]);

  return {
    hours,
    peakFocusHour: bestFocus.focusSeconds ? bestFocus.hour : null,
    peakDistractionHour: worstHour.distractionEvents ? worstHour.hour : null
  };
}

/** Paginated session log — intention, outcome, alignment score, duration. */
export function sessionLog(userId, range, cursor, timezone, limit = 40) {
  const window = rangeToDates(range, timezone);
  const size = Math.min(Number(limit) || 40, 200);
  const before = cursor ? Number(cursor) : Number.MAX_SAFE_INTEGER;

  const rows = all(
    `SELECT * FROM focus_sessions
      WHERE user_id = ? AND local_date BETWEEN ? AND ? AND started_at < ?
      ORDER BY started_at DESC LIMIT ?`,
    [userId, window.start, window.end, before, size + 1]
  );

  const page = rows.slice(0, size);
  return {
    sessions: page.map((s) => ({
      id: s.id,
      localDate: s.local_date,
      startedAt: s.started_at,
      endedAt: s.ended_at,
      plannedMin: s.planned_min,
      actualSeconds: s.actual_seconds,
      intention: s.intention,
      outcome: s.outcome,
      alignmentScore: s.alignment_score
    })),
    nextCursor: rows.length > size ? String(page[page.length - 1].started_at) : null
  };
}

/**
 * Current and longest streak, counted on days that met the daily goal.
 * The extension counts any day with activity, which flatters the number.
 */
export function streaks(userId, timezone, goalMinutes = 120) {
  const rows = all(
    `SELECT local_date, SUM(actual_seconds) AS seconds
       FROM focus_sessions WHERE user_id = ?
      GROUP BY local_date HAVING seconds >= ?
      ORDER BY local_date DESC`,
    [userId, goalMinutes * 60]
  );
  if (!rows.length) return { current: 0, longest: 0 };

  const days = rows.map((r) => r.local_date);
  const today = localDateIn(timezone || "UTC");

  let current = 0;
  const gap = daysBetween(days[0], today);
  if (gap <= 1) {
    current = 1;
    for (let i = 1; i < days.length; i++) {
      if (daysBetween(days[i], days[i - 1]) === 1) current++;
      else break;
    }
  }

  let longest = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    if (daysBetween(days[i], days[i - 1]) === 1) { run++; longest = Math.max(longest, run); }
    else run = 1;
  }

  return { current, longest: Math.max(longest, current) };
}

/** Full dataset for GET /api/stats/export. */
export function exportAll(userId, format) {
  const usage = all("SELECT local_date, domain, seconds, category FROM usage_daily WHERE user_id = ? ORDER BY local_date, domain", [userId]);
  if (format === "csv") {
    const lines = ["date,domain,seconds,category"];
    for (const row of usage) {
      lines.push([row.local_date, row.domain, row.seconds, row.category]
        .map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(","));
    }
    return lines.join("\n") + "\n";
  }
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    usage,
    sessions: all("SELECT * FROM focus_sessions WHERE user_id = ? ORDER BY started_at", [userId]),
    blocks: all("SELECT * FROM block_events WHERE user_id = ? ORDER BY occurred_at", [userId]),
    rules: all("SELECT * FROM rules WHERE user_id = ?", [userId]),
    schedules: all("SELECT * FROM schedules WHERE user_id = ?", [userId]),
    settings: all("SELECT key, value_json, scope FROM settings WHERE user_id = ?", [userId])
  }, null, 2);
}
