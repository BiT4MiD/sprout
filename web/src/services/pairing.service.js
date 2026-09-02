// Device pairing.
//
// Threat model: the pairing code is the only thing between a stranger and a
// user's account, so it is short-lived, single-use, one-per-user, and
// redemption is rate limited hard. 8 Crockford-base32 characters is ~40 bits;
// at 10 attempts an hour a guess takes far longer than the 10-minute window.

import { randomBytes, randomUUID } from "node:crypto";
import { config } from "../config.js";
import { get, all, run, transaction, now } from "../db/index.js";
import { gone, notFound } from "../lib/errors.js";
import { hashToken, newSecret } from "../auth/session.js";
import { audit } from "../auth/middleware.js";

// Crockford base32 minus I, L, O and U — no character a person can misread.
export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LENGTH = 8;

/** Unbiased: reject-sample rather than modulo, which would favour early letters. */
export function generateCode() {
  const out = [];
  const limit = 256 - (256 % CODE_ALPHABET.length);
  while (out.length < CODE_LENGTH) {
    for (const byte of randomBytes(CODE_LENGTH)) {
      if (byte >= limit) continue;
      out.push(CODE_ALPHABET[byte % CODE_ALPHABET.length]);
      if (out.length === CODE_LENGTH) break;
    }
  }
  return out.join("");
}

/** People type these with dashes and lower case; accept both. */
export function normalizeCode(input) {
  return String(input || "").toUpperCase().replace(/[^0-9A-Z]/g, "")
    .replace(/I/g, "1").replace(/L/g, "1").replace(/O/g, "0").replace(/U/g, "V");
}

/** Issues a code, invalidating any previous unused one for this user. */
export function issueCode(userId) {
  return transaction(() => {
    const stamp = now();
    run("DELETE FROM pairing_codes WHERE user_id = ? AND used_at IS NULL", [userId]);
    const code = generateCode();
    run(
      "INSERT INTO pairing_codes (code, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
      [code, userId, stamp, stamp + config.pairingCodeTtlMs]
    );
    return { code, expiresAt: stamp + config.pairingCodeTtlMs };
  });
}

/**
 * Atomic: marks the code used and inserts the device in one transaction, so
 * two simultaneous redemptions cannot both succeed.
 *
 * Unknown, used and expired codes all raise the same error — probing must not
 * be able to tell them apart.
 */
export function redeemCode(rawCode, { name, platform, extensionVersion, ip } = {}) {
  const code = normalizeCode(rawCode);
  return transaction(() => {
    const stamp = now();
    const row = get("SELECT * FROM pairing_codes WHERE code = ?", [code]);
    if (!row || row.used_at || row.expires_at <= stamp) {
      throw gone("pairing_code_expired", "That code is no longer valid. Generate a new one on the dashboard.");
    }

    const token = "spr_dev_" + newSecret(24);
    const result = run(
      `INSERT INTO devices (user_id, name, platform, extension_version, token_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [row.user_id, String(name || "Browser").slice(0, 80),
       platform ? String(platform).slice(0, 80) : null,
       extensionVersion ? String(extensionVersion).slice(0, 20) : null,
       hashToken(token), stamp]
    );
    const deviceId = Number(result.lastInsertRowid);

    run("UPDATE pairing_codes SET used_at = ?, device_id = ? WHERE code = ?", [stamp, deviceId, code]);

    const user = get("SELECT id, email, display_name, timezone FROM users WHERE id = ?", [row.user_id]);
    audit(row.user_id, "device.paired", { deviceId, name, platform }, ip);

    return {
      token,
      device: { id: deviceId, name: name || "Browser" },
      user: { email: user.email, displayName: user.display_name, timezone: user.timezone }
    };
  });
}

export function listDevices(userId, currentDeviceId = null) {
  return all(
    `SELECT id, name, platform, extension_version, last_sync_at, last_sync_version, created_at
       FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
    [userId]
  ).map((d) => ({
    id: d.id,
    name: d.name,
    platform: d.platform,
    extensionVersion: d.extension_version,
    lastSyncAt: d.last_sync_at,
    createdAt: d.created_at,
    current: d.id === currentDeviceId
  }));
}

export function revokeDevice(userId, deviceId, ip) {
  const device = get("SELECT * FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
    [deviceId, userId]);
  if (!device) throw notFound("No such device.");
  run("UPDATE devices SET revoked_at = ? WHERE id = ?", [now(), deviceId]);
  audit(userId, "device.revoked", { deviceId, name: device.name }, ip);
  return { ok: true };
}

/** Housekeeping: expired codes are worthless and should not accumulate. */
export function prunePairingCodes() {
  run("DELETE FROM pairing_codes WHERE expires_at < ?", [now() - 86400000]);
}

export { randomUUID };
