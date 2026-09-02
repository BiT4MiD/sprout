// Fills a database with a demo account so every dashboard screen has
// something real to render before the extension is paired.
//
// The generated history is deliberately shaped rather than uniform-random:
// weekdays beat weekends, focus clusters mid-morning, distraction clusters
// after lunch and late evening, and there are a few genuinely bad days. A
// dashboard tested only against flat noise hides exactly the layout problems
// real data causes.

import { randomUUID } from "node:crypto";
import { getDb, run, get, transaction, closeDb } from "./index.js";
import { ensureSchema } from "./migrate.js";
import { hashPassword } from "../auth/password.js";
import { initialiseSettings } from "../services/settings.service.js";
import { seedDefaultRules } from "../services/rules.service.js";
import { addDays, localDateIn } from "../lib/validate.js";

export const DEMO_EMAIL = "demo@sprout.local";
export const DEMO_PASSWORD = "sprout demo account";

const PRODUCTIVE = ["github.com", "stackoverflow.com", "developer.mozilla.org", "linear.app",
                    "figma.com", "claude.ai", "npmjs.com", "localhost"];
const RESEARCH   = ["docs.google.com", "notion.so", "wikipedia.org", "arxiv.org"];
const NEUTRAL    = ["mail.google.com", "calendar.google.com", "slack.com", "amazon.com", "weather.com"];
const DISTRACT   = ["reddit.com", "youtube.com", "x.com", "news.ycombinator.com",
                    "instagram.com", "netflix.com", "tiktok.com"];

const INTENTIONS = [
  "Ship the theme system", "Fix the sync race condition", "Write the API docs",
  "Review the pull request", "Draft the Q4 plan", "Refactor the settings service",
  "Answer support email", "Prep tomorrow's demo", "Read the spec properly",
  "Clear the bug backlog", "Design the pairing flow", "Untangle the CSS"
];

/** Deterministic PRNG so a reseed produces the same screenshots. */
function makeRandom(seed = 20260902) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export async function seed({ days = 90, timezone = "America/New_York" } = {}) {
  ensureSchema();
  const random = makeRandom();
  const pick = (list) => list[Math.floor(random() * list.length)];
  const between = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));

  const existing = get("SELECT id FROM users WHERE email = ?", [DEMO_EMAIL]);
  if (existing) {
    run("DELETE FROM users WHERE id = ?", [existing.id]);   // cascades everywhere
  }

  const hash = await hashPassword(DEMO_PASSWORD);
  const stamp = Date.now();

  const userId = transaction(() => {
    const result = run(
      `INSERT INTO users (email, display_name, password_hash, timezone, created_at, updated_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [DEMO_EMAIL, "Demo", hash, timezone, stamp - days * 86400000, stamp, stamp]
    );
    const id = Number(result.lastInsertRowid);
    initialiseSettings(id);
    seedDefaultRules(id);
    return id;
  });

  const today = localDateIn(timezone);

  transaction(() => {
    // A couple of named schedules, and rules attached to them.
    const work = Number(run(
      `INSERT INTO schedules (user_id, name, days_mask, start_min, end_min, enabled, created_at, updated_at)
       VALUES (?, 'Work hours', 62, 540, 1020, 1, ?, ?)`,     // Mon–Fri 09:00–17:00
      [userId, stamp, stamp]
    ).lastInsertRowid);
    run(
      `INSERT INTO schedules (user_id, name, days_mask, start_min, end_min, enabled, created_at, updated_at)
       VALUES (?, 'Evening wind-down', 127, 1260, 1380, 1, ?, ?)`,  // every day 21:00–23:00
      [userId, stamp, stamp]
    );
    run("UPDATE rules SET schedule_id = ? WHERE user_id = ? AND pattern IN ('reddit.com','x.com')",
      [work, userId]);

    // A soft shield rather than a hard block, so the Rules page shows both kinds.
    run(
      `INSERT OR IGNORE INTO rules (user_id, pattern, kind, shield_type, enabled, source, note, created_at, updated_at)
       VALUES (?, 'youtube.com', 'shield', 'youtube_zen', 1, 'ai', 'Keeps tutorials, drops the rabbit hole.', ?, ?)`,
      [userId, stamp, stamp]
    );

    for (let offset = days - 1; offset >= 0; offset--) {
      const date = addDays(today, -offset);
      const weekday = new Date(date + "T12:00:00Z").getUTCDay();
      const isWeekend = weekday === 0 || weekday === 6;

      // A handful of days off entirely — real histories have gaps.
      if (random() < (isWeekend ? 0.45 : 0.06)) continue;

      const energy = isWeekend ? 0.35 + random() * 0.4 : 0.6 + random() * 0.55;

      // ---- usage -------------------------------------------------------
      const rows = [
        ...PRODUCTIVE.slice(0, between(3, 6)).map((d) => [d, "productive", Math.floor(between(600, 5400) * energy)]),
        ...RESEARCH.slice(0, between(1, 3)).map((d) => [d, "research", Math.floor(between(300, 2400) * energy)]),
        ...NEUTRAL.slice(0, between(2, 4)).map((d) => [d, "neutral", between(180, 1500)]),
        ...DISTRACT.slice(0, between(2, 5)).map((d) => [d, "distracting", Math.floor(between(300, 4200) * (1.4 - energy * 0.6))])
      ];
      for (const [domain, category, seconds] of rows) {
        if (seconds <= 0) continue;
        run(
          `INSERT INTO usage_daily (user_id, device_id, local_date, domain, seconds, category, updated_at)
           VALUES (?, NULL, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, local_date, domain, device_id)
           DO UPDATE SET seconds = excluded.seconds`,
          [userId, date, domain, seconds, category, stamp]
        );
      }

      // ---- focus sessions ---------------------------------------------
      const sessionCount = isWeekend ? between(0, 2) : between(1, 6);
      for (let i = 0; i < sessionCount; i++) {
        // Mid-morning is the most common start, with a smaller afternoon peak.
        const hour = random() < 0.6 ? between(9, 12) : between(13, 18);
        const minute = between(0, 59);
        const startedAt = Date.parse(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
        const plannedMin = pick([25, 25, 25, 45, 45, 60, 90]);

        const roll = random();
        const outcome = roll < 0.62 ? "accomplished" : roll < 0.84 ? "partially" : roll < 0.94 ? "derailed" : "abandoned";
        const completion = outcome === "accomplished" ? 1
          : outcome === "partially" ? 0.6 + random() * 0.3
          : outcome === "derailed" ? 0.3 + random() * 0.3
          : random() * 0.3;
        const actualSeconds = Math.floor(plannedMin * 60 * completion);
        const alignment = outcome === "accomplished" ? 100
          : outcome === "partially" ? 65 : outcome === "derailed" ? 25 : null;

        run(
          `INSERT INTO focus_sessions
             (user_id, device_id, client_uuid, local_date, started_at, ended_at,
              planned_min, actual_seconds, intention, outcome, alignment_score)
           VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [userId, randomUUID(), date, startedAt, startedAt + actualSeconds * 1000,
           plannedMin, actualSeconds, pick(INTENTIONS), outcome, alignment]
        );
      }

      // ---- block events -----------------------------------------------
      const blockCount = between(0, Math.round(14 * (1.4 - energy * 0.5)));
      for (let i = 0; i < blockCount; i++) {
        // The post-lunch dip and the late evening are when people reach for it.
        const roll = random();
        const hour = roll < 0.45 ? between(13, 16) : roll < 0.75 ? between(20, 23) : between(9, 12);
        run(
          `INSERT OR IGNORE INTO block_events
             (user_id, device_id, client_uuid, domain, local_date, local_hour, occurred_at, outcome)
           VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
          [userId, randomUUID(), pick(DISTRACT), date, hour,
           Date.parse(`${date}T${String(hour).padStart(2, "0")}:${String(between(0, 59)).padStart(2, "0")}:00Z`),
           random() < 0.08 ? "hall_pass" : "blocked"]
        );
      }
    }

    // ---- a few tasks ---------------------------------------------------
    const tasks = [
      ["Finish the theme system", 1], ["Ship v1.3", 1], ["Write the sync tests", 0],
      ["Review the pairing flow", 0], ["Update the changelog", 1]
    ];
    tasks.forEach(([text, done], index) => {
      run(
        `INSERT INTO tasks (user_id, client_uuid, text, done, sort_order, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [userId, randomUUID(), text, done, index, stamp - index * 3600000, done ? stamp : null]
      );
    });

    run("UPDATE users SET sync_version = 1 WHERE id = ?", [userId]);
  });

  const counts = {
    usage: get("SELECT COUNT(*) n FROM usage_daily WHERE user_id = ?", [userId]).n,
    sessions: get("SELECT COUNT(*) n FROM focus_sessions WHERE user_id = ?", [userId]).n,
    blocks: get("SELECT COUNT(*) n FROM block_events WHERE user_id = ?", [userId]).n,
    rules: get("SELECT COUNT(*) n FROM rules WHERE user_id = ?", [userId]).n
  };
  return { userId, email: DEMO_EMAIL, password: DEMO_PASSWORD, counts };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  getDb();
  const result = await seed();
  console.log("Seeded demo account:");
  console.log(`  email    ${result.email}`);
  console.log(`  password ${result.password}`);
  console.log(`  rows     ${result.counts.usage} usage · ${result.counts.sessions} sessions · ` +
              `${result.counts.blocks} blocks · ${result.counts.rules} rules`);
  closeDb();
}
