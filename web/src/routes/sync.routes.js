// POST /api/sync — the only endpoint the extension needs.

import { readJson, sendJson } from "../lib/router.js";
import { rateLimited } from "../lib/errors.js";
import { createLimiter } from "../lib/rateLimit.js";
import { requireDevice } from "../auth/middleware.js";
import { config } from "../config.js";
import { run, now } from "../db/index.js";
import { sync } from "../services/sync.service.js";
import { isTimezone } from "../lib/validate.js";

const syncLimiter = createLimiter(config.rateLimits.sync);

export function resetLimiters() { syncLimiter.reset(); }

export function register(router) {
  router.post("/api/sync", async (req, res) => {
    const gate = syncLimiter.check(`device:${req.ctx.device.id}`);
    if (!gate.ok) throw rateLimited(gate.retryAfterMs);

    // 1 MB is generous for a telemetry batch; a device sending more is
    // misbehaving and gets a 413 rather than unbounded buffering.
    const body = await readJson(req, { limitBytes: 1_000_000 });

    // The extension knows the user's real timezone; the server only ever
    // guessed. Adopt it so every local_date rollup lines up with their day.
    if (body?.timezone && isTimezone(body.timezone) && body.timezone !== req.ctx.user.timezone) {
      run("UPDATE users SET timezone = ?, updated_at = ? WHERE id = ?",
        [body.timezone, now(), req.ctx.user.id]);
    }

    sendJson(res, 200, sync(req.ctx.user.id, req.ctx.device.id, body));
  }, requireDevice);
}
