import { Router } from "express";
import { getInput, validate } from "../../platform/http/validate.js";
import { currentUser } from "../auth/index.js";
import { StatsParamsSchema } from "./stats.schemas.js";
import type { StatsService } from "./stats.service.js";

const schemas = { params: StatsParamsSchema };

export function statsRouter(deps: { service: StatsService }): Router {
  const router = Router();
  router.get("/me/stats/:queryName", validate(schemas), async (req, res) => {
    const { params } = getInput<typeof schemas>(res);
    res.set("cache-control", "no-store");
    res.json(await deps.service.get(currentUser(req), params.queryName));
  });
  return router;
}
