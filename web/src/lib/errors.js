// One error shape for the whole API, so the dashboard has a single code path.

export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code    machine-readable, stable, snake_case
   * @param {string} message human-readable, safe to show a user
   * @param {object} [extra] merged into the error body (e.g. { fields })
   */
  constructor(status, code, message, extra) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const badRequest   = (msg, fields) => new ApiError(400, "validation_failed", msg, fields && { fields });
export const unauthorized = (code = "not_authenticated", msg = "Sign in to continue.") => new ApiError(401, code, msg);
export const forbidden    = (msg = "Not allowed.", code = "forbidden") => new ApiError(403, code, msg);
export const notFound     = (msg = "Not found.") => new ApiError(404, "not_found", msg);
export const conflict     = (code, msg) => new ApiError(409, code, msg);
export const gone         = (code, msg) => new ApiError(410, code, msg);
export const rateLimited  = (retryAfterMs) =>
  new ApiError(429, "rate_limited", "Too many attempts. Try again shortly.", { retry_after_ms: retryAfterMs });
export const payloadTooLarge = () => new ApiError(413, "payload_too_large", "That request was too big.");

/**
 * Terminal error handler. An ApiError is intentional and is sent as-is;
 * anything else is a bug, so it is logged in full and reported as a bare 500.
 * A stack must never reach the client.
 */
export function sendError(res, err) {
  const isApi = err instanceof ApiError;
  if (!isApi) console.error("[sprout] unhandled", err);

  const status = isApi ? err.status : 500;
  const body = JSON.stringify({
    error: Object.assign(
      {
        code: isApi ? err.code : "internal_error",
        message: isApi ? err.message : "Something went wrong."
      },
      isApi ? err.extra : undefined
    )
  });

  if (res.headersSent) { res.end(); return; }
  const headers = { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) };
  if (status === 429 && isApi && err.extra?.retry_after_ms) {
    headers["retry-after"] = String(Math.ceil(err.extra.retry_after_ms / 1000));
  }
  res.writeHead(status, headers);
  res.end(body);
}
