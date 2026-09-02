// Input validation. Every route body goes through a schema here before it
// reaches a service — the services assume their inputs are already clean.

import { badRequest } from "./errors.js";

export const RANGES = ["24h", "7d", "30d", "year", "all"];

/**
 * @param {object} body
 * @param {Record<string, object>} schema  field -> { type, required, min, max, enum, pattern, default }
 * @returns {object} coerced and whitelisted — unknown keys are dropped, not passed through
 * @throws {ApiError} validation_failed carrying a `fields` map
 */
export function parse(body, schema) {
  const input = body && typeof body === "object" ? body : {};
  const out = {};
  const fields = {};

  for (const [key, rule] of Object.entries(schema)) {
    const raw = input[key];
    const missing = raw === undefined || raw === null || raw === "";

    if (missing) {
      if (rule.required) fields[key] = "Required.";
      else if (rule.default !== undefined) out[key] = rule.default;
      continue;
    }

    switch (rule.type) {
      case "string": {
        const value = String(raw).trim();
        if (rule.min && value.length < rule.min) { fields[key] = `Must be at least ${rule.min} characters.`; break; }
        if (rule.max && value.length > rule.max) { fields[key] = `Must be at most ${rule.max} characters.`; break; }
        if (rule.pattern && !rule.pattern.test(value)) { fields[key] = "Not a valid value."; break; }
        out[key] = value;
        break;
      }
      case "email": {
        const value = String(raw).trim().toLowerCase();
        // Deliberately permissive: the only real test of an address is sending to it.
        if (value.length > 254 || !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value)) {
          fields[key] = "Enter a valid email address.";
          break;
        }
        out[key] = value;
        break;
      }
      case "int": {
        const value = Number(raw);
        if (!Number.isFinite(value) || !Number.isInteger(value)) { fields[key] = "Must be a whole number."; break; }
        if (rule.min !== undefined && value < rule.min) { fields[key] = `Must be at least ${rule.min}.`; break; }
        if (rule.max !== undefined && value > rule.max) { fields[key] = `Must be at most ${rule.max}.`; break; }
        out[key] = value;
        break;
      }
      case "float": {
        const value = Number(raw);
        if (!Number.isFinite(value)) { fields[key] = "Must be a number."; break; }
        if (rule.min !== undefined && value < rule.min) { fields[key] = `Must be at least ${rule.min}.`; break; }
        if (rule.max !== undefined && value > rule.max) { fields[key] = `Must be at most ${rule.max}.`; break; }
        out[key] = value;
        break;
      }
      case "bool": {
        if (typeof raw === "boolean") out[key] = raw;
        else if (raw === "true" || raw === 1 || raw === "1") out[key] = true;
        else if (raw === "false" || raw === 0 || raw === "0") out[key] = false;
        else fields[key] = "Must be true or false.";
        break;
      }
      case "enum": {
        const value = String(raw);
        if (!rule.values.includes(value)) { fields[key] = `Must be one of: ${rule.values.join(", ")}.`; break; }
        out[key] = value;
        break;
      }
      case "date": {
        if (!isLocalDate(raw)) { fields[key] = "Must be YYYY-MM-DD."; break; }
        out[key] = String(raw);
        break;
      }
      case "array": {
        if (!Array.isArray(raw)) { fields[key] = "Must be a list."; break; }
        if (rule.max && raw.length > rule.max) { fields[key] = `At most ${rule.max} items.`; break; }
        out[key] = raw;
        break;
      }
      case "object": {
        if (typeof raw !== "object" || Array.isArray(raw)) { fields[key] = "Must be an object."; break; }
        out[key] = raw;
        break;
      }
      default:
        out[key] = raw;
    }
  }

  if (Object.keys(fields).length) {
    throw badRequest("Some fields need attention.", fields);
  }
  return out;
}

/**
 * Domain normalisation. Behaviourally identical to normalizeDomain() in the
 * extension's shared.js — the two must agree or a rule added on the web would
 * not match the same site in the browser.
 */
export function normalizeDomain(input) {
  if (!input) return "";
  return String(input).trim().toLowerCase()
    .replace(/^[a-zA-Z]+:\/\//, "")
    .replace(/^\/\//, "")
    .replace(/^\*\./, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split(":")[0]
    .split("?")[0]
    .trim();
}

export function isLocalDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

export function isTimezone(value) {
  if (typeof value !== "string" || !value) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** 'YYYY-MM-DD' for an instant, in a given IANA zone. */
export function localDateIn(timezone, at = Date.now()) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

/** Shifts a 'YYYY-MM-DD' by whole days, staying on the calendar. */
export function addDays(localDate, days) {
  const [y, m, d] = localDate.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d + days));
  return probe.toISOString().slice(0, 10);
}

export function daysBetween(from, to) {
  const a = Date.parse(from + "T00:00:00Z");
  const b = Date.parse(to + "T00:00:00Z");
  return Math.round((b - a) / 86400000);
}
