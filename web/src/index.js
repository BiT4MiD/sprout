// Sprout Control Centre — HTTP entry point.
//
// Zero npm dependencies: node:http for the server, node:sqlite for storage,
// node:crypto for hashing. `npm start` works on a clean checkout.

import http from "node:http";
import { resolve } from "node:path";
import { config, assertConfigValid } from "./config.js";
import { Router, sendJson } from "./lib/router.js";
import { serveStatic } from "./lib/static.js";
import { sendError } from "./lib/errors.js";
import { applyCors, securityHeaders } from "./auth/middleware.js";
import { ensureSchema } from "./db/migrate.js";
import { pruneSessions } from "./auth/session.js";
import { prunePairingCodes } from "./services/pairing.service.js";

import * as authRoutes from "./routes/auth.routes.js";
import * as deviceRoutes from "./routes/devices.routes.js";
import * as settingsRoutes from "./routes/settings.routes.js";
import * as syncRoutes from "./routes/sync.routes.js";
import * as statsRoutes from "./routes/stats.routes.js";
import * as rulesRoutes from "./routes/rules.routes.js";
import * as accountRoutes from "./routes/account.routes.js";

const PUBLIC_DIR = resolve(config.root, "public");

export function buildRouter() {
  const router = new Router();
  for (const mod of [authRoutes, deviceRoutes, settingsRoutes, syncRoutes,
                     statsRoutes, rulesRoutes, accountRoutes]) {
    mod.register(router);
  }
  router.get("/api/health", async (req, res) => sendJson(res, 200, {
    ok: true,
    name: "sprout-control-centre",
    routes: router.routes.length,
    time: Date.now()
  }));
  return router;
}

/** Clears every in-memory rate limiter. Used by the integration tests. */
export function resetLimiters() {
  authRoutes.resetLimiters();
  deviceRoutes.resetLimiters();
  syncRoutes.resetLimiters();
}

export function createServer() {
  const router = buildRouter();

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    req.query = url.searchParams;

    securityHeaders(res, { isPage: !url.pathname.startsWith("/api/") });

    if (!applyCors(req, res)) {
      return sendJson(res, 403, { error: { code: "origin_not_allowed", message: "This origin isn't allowed." } });
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    if (url.pathname.startsWith("/api/")) {
      const hit = router.match(req.method, url.pathname);
      if (!hit) {
        const allowed = router.allowsPath(url.pathname);
        if (allowed.length) {
          res.setHeader("allow", allowed.join(", "));
          return sendJson(res, 405, {
            error: { code: "method_not_allowed", message: `Use ${allowed.join(" or ")}.` }
          });
        }
        return sendJson(res, 404, { error: { code: "not_found", message: "No such endpoint." } });
      }

      req.params = hit.params;
      try {
        if (hit.guard) await hit.guard(req, res);
        await hit.handler(req, res);
      } catch (err) {
        sendError(res, err);
      }
      return;
    }

    if (await serveStatic(PUBLIC_DIR, url.pathname, res)) return;
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });
}

/** Hourly housekeeping: expired sessions and spent pairing codes. */
function startHousekeeping() {
  const timer = setInterval(() => {
    try { pruneSessions(); prunePairingCodes(); } catch (err) { console.error("[sprout] prune", err); }
  }, 60 * 60 * 1000);
  timer.unref();
  return timer;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    assertConfigValid();
  } catch (err) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  ensureSchema();
  startHousekeeping();

  createServer().listen(config.port, () => {
    console.log(`Sprout Control Centre → http://localhost:${config.port}`);
    console.log(`  database: ${config.databasePath}`);
    console.log(`  origins : ${config.allowedOrigins.join(", ")}`);
  });
}
