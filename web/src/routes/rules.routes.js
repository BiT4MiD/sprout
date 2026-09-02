// Guarded sites, allow-list entries, soft shields and schedules.

import { readJson, sendJson, sendNoContent } from "../lib/router.js";
import { parse } from "../lib/validate.js";
import { badRequest } from "../lib/errors.js";
import { requireSession } from "../auth/middleware.js";
import {
  listRules, createRule, updateRule, deleteRule, bulkAdd,
  listSchedules, createSchedule, updateSchedule, deleteSchedule, SHIELD_TYPES
} from "../services/rules.service.js";

function id(req) {
  const value = Number(req.params.id);
  if (!Number.isInteger(value)) throw badRequest("Bad id.");
  return value;
}

export function register(router) {
  router.get("/api/rules", async (req, res) => {
    sendJson(res, 200, {
      rules: listRules(req.ctx.user.id),
      schedules: listSchedules(req.ctx.user.id)
    });
  }, requireSession);

  router.post("/api/rules", async (req, res) => {
    const body = parse(await readJson(req), {
      pattern: { type: "string", required: true, max: 200 },
      kind: { type: "enum", values: ["block", "allow", "shield"], default: "block" },
      shieldType: { type: "enum", values: SHIELD_TYPES },
      scheduleId: { type: "int" },
      note: { type: "string", max: 300 }
    });
    sendJson(res, 201, createRule(req.ctx.user.id, body));
  }, requireSession);

  router.post("/api/rules/bulk", async (req, res) => {
    const body = parse(await readJson(req), {
      patterns: { type: "string", required: true, max: 20000 },
      kind: { type: "enum", values: ["block", "allow"], default: "block" }
    });
    sendJson(res, 200, bulkAdd(req.ctx.user.id, body.patterns, body.kind));
  }, requireSession);

  router.patch("/api/rules/:id", async (req, res) => {
    const body = parse(await readJson(req), {
      enabled: { type: "bool" },
      kind: { type: "enum", values: ["block", "allow", "shield"] },
      shieldType: { type: "enum", values: SHIELD_TYPES },
      scheduleId: { type: "int" },
      note: { type: "string", max: 300 }
    });
    sendJson(res, 200, updateRule(req.ctx.user.id, id(req), body));
  }, requireSession);

  router.delete("/api/rules/:id", async (req, res) => {
    deleteRule(req.ctx.user.id, id(req));
    sendNoContent(res);
  }, requireSession);

  // ------------------------------------------------------- schedules
  router.get("/api/schedules", async (req, res) => {
    sendJson(res, 200, { schedules: listSchedules(req.ctx.user.id) });
  }, requireSession);

  router.post("/api/schedules", async (req, res) => {
    const body = parse(await readJson(req), {
      name: { type: "string", required: true, max: 60 },
      daysMask: { type: "int", min: 0, max: 127, default: 127 },
      startMin: { type: "int", required: true, min: 0, max: 1439 },
      endMin: { type: "int", required: true, min: 0, max: 1439 }
    });
    sendJson(res, 201, createSchedule(req.ctx.user.id, body));
  }, requireSession);

  router.patch("/api/schedules/:id", async (req, res) => {
    const body = parse(await readJson(req), {
      name: { type: "string", max: 60 },
      daysMask: { type: "int", min: 0, max: 127 },
      startMin: { type: "int", min: 0, max: 1439 },
      endMin: { type: "int", min: 0, max: 1439 },
      enabled: { type: "bool" }
    });
    sendJson(res, 200, updateSchedule(req.ctx.user.id, id(req), body));
  }, requireSession);

  router.delete("/api/schedules/:id", async (req, res) => {
    deleteSchedule(req.ctx.user.id, id(req));
    sendNoContent(res);
  }, requireSession);
}
