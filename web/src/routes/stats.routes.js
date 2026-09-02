// Read-only analytics. See docs/API.md → "Dashboard data".

import { sendJson, sendText } from "../lib/router.js";
import { badRequest } from "../lib/errors.js";
import { requireSession } from "../auth/middleware.js";
import { RANGES as VALID_RANGES } from "../lib/validate.js";
import {
  summary, timeseries, domains, hourly, sessionLog, exportAll
} from "../services/stats.service.js";

function range(req) {
  const value = req.query.get("range") || "7d";
  if (!VALID_RANGES.includes(value)) {
    throw badRequest("Unknown range.", { range: `Must be one of: ${VALID_RANGES.join(", ")}.` });
  }
  return value;
}

export function register(router) {
  router.get("/api/stats/summary", async (req, res) => {
    sendJson(res, 200, summary(req.ctx.user.id, range(req), req.ctx.user.timezone));
  }, requireSession);

  router.get("/api/stats/timeseries", async (req, res) => {
    const bucket = req.query.get("bucket") === "hour" ? "hour" : "day";
    sendJson(res, 200, timeseries(req.ctx.user.id, range(req), bucket, req.ctx.user.timezone));
  }, requireSession);

  router.get("/api/stats/domains", async (req, res) => {
    const category = req.query.get("category");
    if (category && !["productive", "research", "neutral", "distracting"].includes(category)) {
      throw badRequest("Unknown category.", { category: "Not a category Sprout uses." });
    }
    sendJson(res, 200, domains(
      req.ctx.user.id, range(req),
      { limit: req.query.get("limit"), category },
      req.ctx.user.timezone
    ));
  }, requireSession);

  router.get("/api/stats/hourly", async (req, res) => {
    sendJson(res, 200, hourly(req.ctx.user.id, range(req), req.ctx.user.timezone));
  }, requireSession);

  router.get("/api/stats/sessions", async (req, res) => {
    sendJson(res, 200, sessionLog(
      req.ctx.user.id, range(req), req.query.get("cursor"),
      req.ctx.user.timezone, req.query.get("limit")
    ));
  }, requireSession);

  router.get("/api/stats/export", async (req, res) => {
    const format = req.query.get("format") === "json" ? "json" : "csv";
    const body = exportAll(req.ctx.user.id, format);
    const stamp = new Date().toISOString().slice(0, 10);
    sendText(res, 200, body,
      format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
      { "content-disposition": `attachment; filename="sprout-${stamp}.${format}"` });
  }, requireSession);
}
