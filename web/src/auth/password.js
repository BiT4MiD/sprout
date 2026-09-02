// Password hashing. scrypt from node:crypto — memory-hard, no dependency, and
// the cost parameters are stored alongside the hash so they can be raised
// later without invalidating existing accounts.

import { scrypt as scryptCb, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { config } from "../config.js";

const scrypt = promisify(scryptCb);

// A password everyone tries. Short list on purpose: long blocklists mostly
// annoy people, while the length rule does the real work.
const COMMON = new Set([
  "password", "password1", "password123", "passw0rd!", "qwertyuiop",
  "1234567890", "12345678910", "letmein123", "iloveyou1", "welcome123",
  "admin12345", "sprout1234", "changeme123", "trustno1234", "monkey12345",
  "football123", "baseball123", "dragon12345", "sunshine123", "princess123",
  "qwerty12345", "abc123456789", "1qaz2wsx3edc", "zaq12wsxcde3"
]);

/** @returns {Promise<string>} "scrypt$N$r$p$<salt b64>$<hash b64>" */
export async function hashPassword(password) {
  const { N, r, p, keyLen } = config.scrypt;
  const salt = randomBytes(16);
  // maxmem must be raised for N=2^15; the default 32MB is not enough.
  const derived = await scrypt(password, salt, keyLen, { N, r, p, maxmem: 256 * 1024 * 1024 });
  return ["scrypt", N, r, p, salt.toString("base64"), derived.toString("base64")].join("$");
}

/**
 * Constant-time compare. Still runs a full scrypt when the stored hash is
 * missing (unknown email), so response timing cannot be used to tell whether
 * an account exists.
 */
export async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string") {
    await hashPassword(String(password || "x"));   // burn the same time
    return false;
  }
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    await hashPassword(String(password || "x"));
    return false;
  }
  const [, N, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  let derived;
  try {
    derived = await scrypt(password, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 256 * 1024 * 1024
    });
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * @returns {{ ok: boolean, reason?: string }}
 * Length is the rule that matters. No character-class requirements — they push
 * people toward "Passw0rd!" without adding entropy.
 */
export function validatePasswordStrength(password, { email } = {}) {
  const value = String(password || "");
  if (value.length < 10) return { ok: false, reason: "Use at least 10 characters — a short phrase works well." };
  if (value.length > 200) return { ok: false, reason: "That's longer than 200 characters." };
  if (COMMON.has(value.toLowerCase())) return { ok: false, reason: "That password is one of the most commonly used. Pick another." };
  if (/^(.)\1+$/.test(value)) return { ok: false, reason: "That's the same character repeated." };
  if (email) {
    // Reject a password that is *mostly* the email local-part ("tahmid1234"),
    // not one that merely contains it as a substring — "another good long
    // phrase" should not be refused because the address is other@example.com.
    const local = String(email).split("@")[0].toLowerCase();
    if (local.length >= 4) {
      const stripped = value.toLowerCase().split(local).join("");
      if (stripped.length < 6) {
        return { ok: false, reason: "That's mostly your email address. Try something unrelated." };
      }
    }
  }
  return { ok: true };
}
