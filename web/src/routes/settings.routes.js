// GET /api/settings [session or device]   PATCH /api/settings [session]
// Validation comes from SETTINGS_CATALOGUE, so a typo cannot create a dead key.

import { readJson, sendJson } from "../lib/router.js";
import { requireSession, requireAny } from "../auth/middleware.js";
import { getEffectiveSettings, patchSettings, settingsMeta } from "../services/settings.service.js";

export function register(router) {
  router.get("/api/settings", async (req, res) => {
    const deviceId = req.ctx.device?.id ?? null;
    // Only the extension, on a device token, receives the real Gemini key —
    // it is the thing that actually calls Google.
    const includeSecrets = req.ctx.actor === "device";
    const result = getEffectiveSettings(req.ctx.user.id, deviceId, { includeSecrets });
    sendJson(res, 200, Object.assign(result, settingsMeta()));
  }, requireAny);

  router.patch("/api/settings", async (req, res) => {
    const patch = await readJson(req);
    const result = patchSettings(req.ctx.user.id, null, patch, { actor: "session" });
    sendJson(res, 200, Object.assign(result, settingsMeta()));
  }, requireSession);
}
