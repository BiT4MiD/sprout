// Request guards. Each attaches context to `req.ctx` or throws an ApiError,
// which src/index.js turns into the standard error envelope.

import { config } from "../config.js";
import { get, run, now } from "../db/index.js";
import { unauthorized, forbidden } from "../lib/errors.js";
import {
  COOKIE_NAME, parseCookies, resolveSession, csrfValid, hashToken
} from "./session.js";

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Session cookie required. On unsafe methods also enforces the double-submit
 * CSRF token — the cookie alone is not proof of intent, because a
 * cross-origin form can send it.
 */
export function requireSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  const resolved = resolveSession(cookies[COOKIE_NAME]);
  if (!resolved) throw unauthorized();

  if (UNSAFE.has(req.method)) {
    const presented = req.headers["x-csrf-token"];
    if (!csrfValid(resolved.session.id, resolved.secret, presented)) {
      throw forbidden("Your page is out of date — reload and try again.", "csrf_failed");
    }
  }
  req.ctx = { user: resolved.user, session: resolved.session, secret: resolved.secret, actor: "session" };
}

/**
 * Bearer device token required. A revoked token must return 401 invalid_token —
 * the extension treats exactly that as "forget this pairing".
 */
export function requireDevice(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw unauthorized("invalid_token", "This browser is not paired.");

  const device = get(
    "SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL",
    [hashToken(token)]
  );
  if (!device) throw unauthorized("invalid_token", "This pairing is no longer valid.");

  const user = get("SELECT * FROM users WHERE id = ?", [device.user_id]);
  if (!user) throw unauthorized("invalid_token", "This pairing is no longer valid.");

  run("UPDATE devices SET last_sync_at = ? WHERE id = ?", [now(), device.id]);
  req.ctx = { user, device, actor: "device" };
}

/** Either credential — used by GET /api/settings, which both clients read. */
export function requireAny(req) {
  if (req.headers.authorization) return requireDevice(req);
  return requireSession(req);
}

/**
 * CORS. Reflects only configured origins and always sets Vary: Origin.
 * Never `*` with credentials — that combination is what turns a dashboard
 * into a CSRF hole.
 *
 * The extension's service worker sends Origin: chrome-extension://<id> on
 * fetch; it authenticates by bearer token, so it is allowed without being
 * in the list, but never with credentials.
 */
export function applyCors(req, res) {
  const origin = req.headers.origin;
  res.setHeader("Vary", "Origin");
  if (!origin) return true;

  if (config.allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  } else if (origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    return false;
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, x-csrf-token");
  res.setHeader("Access-Control-Max-Age", "600");
  return true;
}

export function securityHeaders(res, { isPage = false } = {}) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  if (isPage) {
    // script-src stays strict — that is the directive that actually stops XSS,
    // and every script here is a file on disk. style-src needs 'unsafe-inline'
    // because the charts set per-mark colour and geometry from data; the
    // alternative is a class for every possible value, and a style attribute
    // cannot execute script.
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; " +
      "frame-ancestors 'none'; object-src 'none'"
    );
  }
  if (config.isProd) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

/** Append-only record of security-relevant actions, shown on the Account page. */
export function audit(userId, action, detail, ip) {
  run(
    "INSERT INTO audit_log (user_id, action, detail_json, ip, created_at) VALUES (?, ?, ?, ?, ?)",
    [userId ?? null, action, detail ? JSON.stringify(detail) : null, ip || null, now()]
  );
}
