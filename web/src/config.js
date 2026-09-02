// Environment configuration, read once at boot and validated loudly.
// A misconfigured secret should stop the server, not silently weaken it.

import { readFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Minimal .env reader — avoids a dependency for six values. */
function loadDotEnv() {
  const file = resolve(ROOT, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] === undefined) {
      process.env[key] = trimmed.slice(eq + 1).trim();
    }
  }
}
loadDotEnv();

const isProd = process.env.NODE_ENV === "production";

export const config = {
  root: ROOT,
  port: Number(process.env.PORT || 8787),
  isProd,
  databasePath: resolve(ROOT, process.env.DATABASE_PATH || "./data/sprout.db"),
  sessionSecret: process.env.SESSION_SECRET || "",
  sessionTtlMs: Number(process.env.SESSION_TTL_DAYS || 30) * 24 * 60 * 60 * 1000,
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "http://localhost:8787")
    .split(",").map((o) => o.trim()).filter(Boolean),

  // Tuning knobs the rest of the code reads instead of hard-coding.
  pairingCodeTtlMs: 10 * 60 * 1000,
  scrypt: { N: 1 << 15, r: 8, p: 1, keyLen: 64 },
  rateLimits: {
    login:  { windowMs: 15 * 60 * 1000, max: 5 },
    signup: { windowMs: 60 * 60 * 1000, max: 5 },
    redeem: { windowMs: 60 * 60 * 1000, max: 10 },
    sync:   { windowMs: 60 * 1000,      max: 30 }
  }
};

/**
 * Refuses to start on a misconfiguration rather than starting weakened.
 * In development a missing secret is generated and warned about, so a fresh
 * checkout runs; in production it is a hard failure.
 */
export function assertConfigValid() {
  const problems = [];

  if (!config.sessionSecret) {
    if (config.isProd) {
      problems.push("SESSION_SECRET is not set.");
    } else {
      config.sessionSecret = randomBytes(32).toString("base64");
      console.warn("[sprout] SESSION_SECRET not set — generated an ephemeral one. " +
                   "Sessions will not survive a restart. Set it in .env.");
    }
  } else if (Buffer.from(config.sessionSecret, "base64").length < 32) {
    problems.push("SESSION_SECRET must decode to at least 32 bytes.");
  }

  if (config.isProd) {
    const insecure = config.allowedOrigins.filter((o) => o.startsWith("http://"));
    if (insecure.length) {
      problems.push(`Refusing to run in production with plain-http origins: ${insecure.join(", ")}`);
    }
  }

  if (!Number.isFinite(config.port) || config.port < 1 || config.port > 65535) {
    problems.push(`PORT is not a valid port: ${config.port}`);
  }

  if (problems.length) {
    throw new Error("Configuration problems:\n  - " + problems.join("\n  - "));
  }
  return true;
}
