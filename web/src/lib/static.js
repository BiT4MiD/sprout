// Serves web/public. Small, explicit, and refuses anything outside the root.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve, extname, normalize, sep } from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
  ".woff2":"font/woff2"
};

export async function serveStatic(root, pathname, res) {
  // "/"  -> index.html ;  "/app" -> app.html (clean URLs, no router needed)
  let rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (!extname(rel)) rel += ".html";

  const full = resolve(root, normalize(rel));
  if (!full.startsWith(root + sep)) return false;   // path traversal

  try {
    const info = await stat(full);
    if (!info.isFile()) return false;
    res.writeHead(200, {
      "content-type": TYPES[extname(full)] || "application/octet-stream",
      "content-length": info.size,
      "cache-control": extname(full) === ".html" ? "no-cache" : "public, max-age=3600"
    });
    createReadStream(full).pipe(res);
    return true;
  } catch {
    return false;
  }
}
