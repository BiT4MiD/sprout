// Dashboard sessions. Opaque random tokens, not JWTs: revocation has to be
// immediate ("sign out my other browsers"), and a lookup per request costs
// nothing against a local SQLite file.
//
// Cookie value is "<session id>.<secret>".
//   - the id indexes the row
//   - only SHA-256(secret) is stored, so a leaked database cannot be replayed
//   - HttpOnly, SameSite=Lax, Secure in production, Path=/

import { randomBytes, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { get, run, now } from "../db/index.js";

export const COOKIE_NAME = "sprout_sid";
const TOUCH_INTERVAL_MS = 60_000;

export function newSecret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(secret) {
  return createHash("sha256").update(secret).digest("hex");
}

export function createSession(userId, { userAgent, ip } = {}) {
  const id = randomBytes(16).toString("base64url");
  const secret = newSecret();
  const created = now();
  run(
    `INSERT INTO sessions (id, user_id, token_hash, user_agent, ip, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, hashToken(secret), (userAgent || "").slice(0, 300), ip || null,
     created, created, created + config.sessionTtlMs]
  );
  return { cookie: `${id}.${secret}`, id, secret, expiresAt: created + config.sessionTtlMs };
}

/** @returns {{ user: object, session: object, secret: string } | null} */
export function resolveSession(cookieValue) {
  if (!cookieValue || typeof cookieValue !== "string") return null;
  const dot = cookieValue.indexOf(".");
  if (dot <= 0) return null;

  const id = cookieValue.slice(0, dot);
  const secret = cookieValue.slice(dot + 1);
  const session = get("SELECT * FROM sessions WHERE id = ?", [id]);
  if (!session || session.revoked_at) return null;

  const expected = Buffer.from(session.token_hash, "hex");
  const actual = Buffer.from(hashToken(secret), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  const current = now();
  if (session.expires_at <= current) return null;

  const user = get("SELECT * FROM users WHERE id = ?", [session.user_id]);
  if (!user) return null;

  // Refresh at most once a minute — a write on every request would be pure noise.
  if (current - session.last_seen_at > TOUCH_INTERVAL_MS) {
    run("UPDATE sessions SET last_seen_at = ? WHERE id = ?", [current, id]);
  }
  return { user, session, secret };
}

export function revokeSession(sessionId) {
  run("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [now(), sessionId]);
}

/** After a password change: kills every session except the one in use. */
export function revokeOtherSessions(userId, keepSessionId) {
  run(
    "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL",
    [now(), userId, keepSessionId]
  );
}

/**
 * Double-submit CSRF token, derived from the session secret with the server
 * key — so it needs no storage, and cannot be forged by a cross-origin page
 * that can send the cookie but not read it.
 */
export function csrfTokenFor(sessionId, secret) {
  return createHmac("sha256", config.sessionSecret || "dev-secret")
    .update(`${sessionId}.${secret}`)
    .digest("base64url");
}

export function csrfValid(sessionId, secret, presented) {
  if (!presented) return false;
  const expected = Buffer.from(csrfTokenFor(sessionId, secret));
  const actual = Buffer.from(String(presented));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function serializeCookie(value, { maxAgeMs, secure } = {}) {
  const parts = [
    `${COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax"
  ];
  if (secure ?? config.isProd) parts.push("Secure");
  parts.push(`Max-Age=${Math.floor((maxAgeMs ?? config.sessionTtlMs) / 1000)}`);
  return parts.join("; ");
}

export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const pair of String(header).split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return out;
}

/** Purges rows that can no longer authenticate anything. */
export function pruneSessions() {
  run("DELETE FROM sessions WHERE expires_at < ? OR revoked_at IS NOT NULL", [now() - 86400000]);
}
