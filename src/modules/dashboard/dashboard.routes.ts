import { Router } from "express";
import { getInput, validate } from "../../platform/http/validate.js";
import { currentUser } from "../auth/index.js";
import { SessionParamsSchema } from "../sessions/index.js";
import type { DashboardService } from "./dashboard.service.js";

const schemas = { params: SessionParamsSchema };

export function dashboardRouter(deps: { service: DashboardService }): Router {
  const router = Router();
  router.get("/sessions/:sessionId/dashboard", validate(schemas), async (req, res) => {
    const { params } = getInput<typeof schemas>(res);
    res.set("cache-control", "no-store");
    res.json(await deps.service.getSnapshot(currentUser(req), params.sessionId));
  });
  return router;
}
