// In-memory fixed-window rate limiter.
//
// Deliberately not Redis: this is a single-process server. If it ever runs
// multiple instances, swap the Map for a `rate_limits` table — the interface
// below is what the rest of the code depends on.

/**
 * @param {{windowMs: number, max: number}} options
 * @returns {{ check: (key: string) => {ok: boolean, retryAfterMs: number}, reset: () => void }}
 */
export function createLimiter({ windowMs, max }) {
  /** @type {Map<string, {count: number, resetAt: number}>} */
  const buckets = new Map();
  let lastSweep = 0;

  function sweep(now) {
    // Amortised cleanup: once a window, drop everything already expired, so a
    // long-running process can't accumulate a bucket per attacker IP forever.
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }

  return {
    check(key) {
      const now = Date.now();
      sweep(now);
      let bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(key, bucket);
      }
      bucket.count++;
      if (bucket.count > max) {
        return { ok: false, retryAfterMs: bucket.resetAt - now };
      }
      return { ok: true, retryAfterMs: 0 };
    },
    reset() { buckets.clear(); }
  };
}

/**
 * Login is limited per IP *and* per email, so an attacker cannot lock a victim
 * out by burning that victim's quota from many addresses.
 */
export function loginKey(ip, email) {
  return `${ip}|${String(email || "").toLowerCase()}`;
}

export function clientIp(req) {
  // Only trust X-Forwarded-For behind a proxy you control; the direct socket
  // address is the honest default for a self-hosted server.
  return req.socket?.remoteAddress || "unknown";
}
