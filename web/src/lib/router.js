// A small router over node:http.
//
// No Express. The whole API is ~31 routes with one middleware chain; a
// framework would be more code to read than this, and staying on the standard
// library means the server has no dependencies at all.

import { payloadTooLarge, badRequest } from "./errors.js";

export class Router {
  constructor() {
    /** @type {{method:string, segments:string[], handler:Function, guard:Function|null}[]} */
    this.routes = [];
  }

  add(method, path, handler, guard = null) {
    this.routes.push({ method, segments: path.split("/").filter(Boolean), handler, guard });
    return this;
  }

  get(p, h, g)    { return this.add("GET", p, h, g); }
  post(p, h, g)   { return this.add("POST", p, h, g); }
  patch(p, h, g)  { return this.add("PATCH", p, h, g); }
  put(p, h, g)    { return this.add("PUT", p, h, g); }
  delete(p, h, g) { return this.add("DELETE", p, h, g); }

  /** @returns {{handler:Function, guard:Function|null, params:object} | null} */
  match(method, pathname) {
    const parts = pathname.split("/").filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = route.segments[i];
        if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(parts[i]);
        else if (seg !== parts[i]) { ok = false; break; }
      }
      if (ok) return { handler: route.handler, guard: route.guard, params };
    }
    return null;
  }

  /** Methods this path accepts — lets us answer 405 instead of a misleading 404. */
  allowsPath(pathname) {
    const parts = pathname.split("/").filter(Boolean);
    return this.routes
      .filter((r) => r.segments.length === parts.length &&
        r.segments.every((s, i) => s.startsWith(":") || s === parts[i]))
      .map((r) => r.method);
  }
}

/**
 * Reads a JSON body with a hard size cap, destroying the socket rather than
 * buffering an unbounded upload.
 */
export function readJson(req, { limitBytes = 1_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > limitBytes) { req.destroy(); reject(payloadTooLarge()); return; }

    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) { req.destroy(); reject(payloadTooLarge()); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!size) { resolve({}); return; }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(badRequest("That request body wasn't valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload ?? null);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

export function sendNoContent(res) {
  res.writeHead(204);
  res.end();
}

export function sendText(res, status, text, contentType = "text/plain; charset=utf-8", headers = {}) {
  res.writeHead(status, Object.assign({
    "content-type": contentType,
    "content-length": Buffer.byteLength(text)
  }, headers));
  res.end(text);
}
