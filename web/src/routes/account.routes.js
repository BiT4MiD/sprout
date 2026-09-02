// Audit log, data export and account deletion.

import { readJson, sendJson, sendText, sendNoContent } from "../lib/router.js";
import { parse } from "../lib/validate.js";
import { unauthorized } from "../lib/errors.js";
import { requireSession, audit } from "../auth/middleware.js";
import { clientIp } from "../lib/rateLimit.js";
import { all, run, transaction } from "../db/index.js";
import { verifyPassword } from "../auth/password.js";
import { clearCookie } from "../auth/session.js";
import { exportAll } from "../services/stats.service.js";

export function register(router) {
  router.get("/api/account/audit", async (req, res) => {
    const limit = Math.min(Number(req.query.get("limit")) || 50, 200);
    const entries = all(
      "SELECT action, detail_json, ip, created_at FROM audit_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
      [req.ctx.user.id, limit]
    ).map((row) => ({
      action: row.action,
      detail: row.detail_json ? JSON.parse(row.detail_json) : null,
      ip: row.ip,
      createdAt: row.created_at
    }));
    sendJson(res, 200, { entries });
  }, requireSession);

  router.post("/api/account/export", async (req, res) => {
    const stamp = new Date().toISOString().slice(0, 10);
    sendText(res, 200, exportAll(req.ctx.user.id, "json"),
      "application/json; charset=utf-8",
      { "content-disposition": `attachment; filename="sprout-account-${stamp}.json"` });
  }, requireSession);

  router.delete("/api/account", async (req, res) => {
    const body = parse(await readJson(req), {
      password: { type: "string", required: true, max: 200 }
    });
    const ok = await verifyPassword(body.password, req.ctx.user.password_hash);
    if (!ok) throw unauthorized("invalid_credentials", "That password is not correct.");

    const userId = req.ctx.user.id;
    audit(userId, "account.deleted", null, clientIp(req));
    // ON DELETE CASCADE clears sessions, devices, settings, rules, schedules,
    // usage, focus_sessions, block_events and tasks in one statement.
    transaction(() => run("DELETE FROM users WHERE id = ?", [userId]));

    res.setHeader("Set-Cookie", clearCookie());
    sendNoContent(res);
  }, requireSession);
}
