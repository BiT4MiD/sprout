// POST /api/auth/signup | login | logout | password   GET /api/auth/me
// See docs/API.md → "Auth".

import { get, run, transaction, now } from "../db/index.js";
import { readJson, sendJson, sendNoContent } from "../lib/router.js";
import { parse, isTimezone } from "../lib/validate.js";
import { conflict, unauthorized, badRequest, rateLimited } from "../lib/errors.js";
import { createLimiter, loginKey, clientIp } from "../lib/rateLimit.js";
import { hashPassword, verifyPassword, validatePasswordStrength } from "../auth/password.js";
import {
  createSession, revokeSession, revokeOtherSessions,
  csrfTokenFor, serializeCookie, clearCookie
} from "../auth/session.js";
import { requireSession, audit } from "../auth/middleware.js";
import { config } from "../config.js";
import { initialiseSettings } from "../services/settings.service.js";
import { seedDefaultRules } from "../services/rules.service.js";

const loginLimiter = createLimiter(config.rateLimits.login);
const signupLimiter = createLimiter(config.rateLimits.signup);

/** Test hook — integration tests hammer these endpoints deliberately. */
export function resetLimiters() {
  loginLimiter.reset();
  signupLimiter.reset();
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    timezone: user.timezone,
    createdAt: user.created_at
  };
}

export function register(router) {
  // ------------------------------------------------------------ signup
  router.post("/api/auth/signup", async (req, res) => {
    const ip = clientIp(req);
    const gate = signupLimiter.check(ip);
    if (!gate.ok) throw rateLimited(gate.retryAfterMs);

    const body = parse(await readJson(req), {
      email: { type: "email", required: true },
      password: { type: "string", required: true, max: 200 },
      displayName: { type: "string", max: 80 },
      timezone: { type: "string", max: 60, default: "UTC" }
    });

    const strength = validatePasswordStrength(body.password, { email: body.email });
    if (!strength.ok) throw badRequest("Choose a stronger password.", { password: strength.reason });
    if (!isTimezone(body.timezone)) body.timezone = "UTC";

    const existing = get("SELECT id FROM users WHERE email = ?", [body.email]);
    if (existing) {
      // The address is taken, but saying so would let anyone enumerate accounts.
      throw conflict("email_taken", "That email can't be used to create an account.");
    }

    const hash = await hashPassword(body.password);
    const stamp = now();

    const userId = transaction(() => {
      const result = run(
        `INSERT INTO users (email, display_name, password_hash, timezone, created_at, updated_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [body.email, body.displayName || null, hash, body.timezone, stamp, stamp, stamp]
      );
      const id = Number(result.lastInsertRowid);
      initialiseSettings(id);
      seedDefaultRules(id);
      return id;
    });

    const user = get("SELECT * FROM users WHERE id = ?", [userId]);
    const session = createSession(userId, { userAgent: req.headers["user-agent"], ip });
    audit(userId, "account.created", { email: body.email }, ip);

    res.setHeader("Set-Cookie", serializeCookie(session.cookie));
    sendJson(res, 201, {
      user: publicUser(user),
      csrfToken: csrfTokenFor(session.id, session.secret)
    });
  });

  // ------------------------------------------------------------- login
  router.post("/api/auth/login", async (req, res) => {
    const ip = clientIp(req);
    const body = parse(await readJson(req), {
      email: { type: "email", required: true },
      password: { type: "string", required: true, max: 200 }
    });

    const gate = loginLimiter.check(loginKey(ip, body.email));
    if (!gate.ok) throw rateLimited(gate.retryAfterMs);

    const user = get("SELECT * FROM users WHERE email = ?", [body.email]);
    // verifyPassword runs a full scrypt even when `user` is null, so the
    // response time is the same whether or not the account exists.
    const ok = await verifyPassword(body.password, user ? user.password_hash : null);
    if (!user || !ok) {
      audit(user ? user.id : null, "login.failed", { email: body.email }, ip);
      throw unauthorized("invalid_credentials", "Email or password is incorrect.");
    }

    run("UPDATE users SET last_login_at = ? WHERE id = ?", [now(), user.id]);
    const session = createSession(user.id, { userAgent: req.headers["user-agent"], ip });
    audit(user.id, "login.success", null, ip);

    res.setHeader("Set-Cookie", serializeCookie(session.cookie));
    sendJson(res, 200, {
      user: publicUser(user),
      csrfToken: csrfTokenFor(session.id, session.secret)
    });
  });

  // ------------------------------------------------------------ logout
  router.post("/api/auth/logout", async (req, res) => {
    revokeSession(req.ctx.session.id);
    audit(req.ctx.user.id, "logout", null, clientIp(req));
    res.setHeader("Set-Cookie", clearCookie());
    sendNoContent(res);
  }, requireSession);

  // ---------------------------------------------------------------- me
  router.get("/api/auth/me", async (req, res) => {
    sendJson(res, 200, {
      user: publicUser(req.ctx.user),
      csrfToken: csrfTokenFor(req.ctx.session.id, req.ctx.secret)
    });
  }, requireSession);

  // ---------------------------------------------------- change password
  router.post("/api/auth/password", async (req, res) => {
    const body = parse(await readJson(req), {
      currentPassword: { type: "string", required: true, max: 200 },
      newPassword: { type: "string", required: true, max: 200 }
    });

    const ok = await verifyPassword(body.currentPassword, req.ctx.user.password_hash);
    if (!ok) throw unauthorized("invalid_credentials", "That's not your current password.");

    const strength = validatePasswordStrength(body.newPassword, { email: req.ctx.user.email });
    if (!strength.ok) throw badRequest("Choose a stronger password.", { newPassword: strength.reason });

    const hash = await hashPassword(body.newPassword);
    run("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?", [hash, now(), req.ctx.user.id]);

    // Every other browser loses its session; paired extensions keep working,
    // because a device token is a separate credential the user can revoke
    // individually from the Devices page.
    revokeOtherSessions(req.ctx.user.id, req.ctx.session.id);
    audit(req.ctx.user.id, "password.changed", null, clientIp(req));
    sendNoContent(res);
  }, requireSession);
}
