// Pairing and device management. See docs/API.md → "Devices & pairing".

import { readJson, sendJson, sendNoContent } from "../lib/router.js";
import { parse } from "../lib/validate.js";
import { rateLimited, badRequest } from "../lib/errors.js";
import { createLimiter, clientIp } from "../lib/rateLimit.js";
import { requireSession } from "../auth/middleware.js";
import { config } from "../config.js";
import { issueCode, redeemCode, listDevices, revokeDevice } from "../services/pairing.service.js";

const redeemLimiter = createLimiter(config.rateLimits.redeem);

export function resetLimiters() { redeemLimiter.reset(); }

export function register(router) {
  // Mint a code for the extension to redeem.
  router.post("/api/devices/pair-code", async (req, res) => {
    sendJson(res, 200, issueCode(req.ctx.user.id));
  }, requireSession);

  // No auth: the code IS the credential. Rate limited hard, because this is
  // the one endpoint an attacker could brute-force.
  router.post("/api/devices/redeem", async (req, res) => {
    const ip = clientIp(req);
    const gate = redeemLimiter.check(ip);
    if (!gate.ok) throw rateLimited(gate.retryAfterMs);

    const body = parse(await readJson(req), {
      code: { type: "string", required: true, max: 20 },
      name: { type: "string", max: 80, default: "Browser" },
      platform: { type: "string", max: 80 },
      extensionVersion: { type: "string", max: 20 }
    });

    sendJson(res, 201, redeemCode(body.code, {
      name: body.name,
      platform: body.platform,
      extensionVersion: body.extensionVersion,
      ip
    }));
  });

  router.get("/api/devices", async (req, res) => {
    sendJson(res, 200, { devices: listDevices(req.ctx.user.id) });
  }, requireSession);

  router.delete("/api/devices/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw badRequest("Bad device id.");
    revokeDevice(req.ctx.user.id, id, clientIp(req));
    sendNoContent(res);
  }, requireSession);
}
