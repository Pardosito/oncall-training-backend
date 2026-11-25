import { Router } from "express";
import { getInput, validate } from "../../platform/http/validate.js";
import { currentUser } from "../auth/index.js";
import { LeaderboardParamsSchema, LeaderboardQuerySchema } from "./leaderboard.schemas.js";
import type { LeaderboardService } from "./leaderboard.service.js";

const schemas = { params: LeaderboardParamsSchema, query: LeaderboardQuerySchema };

export function leaderboardRouter(deps: { service: LeaderboardService }): Router {
  const router = Router();
  router.get("/leaderboard/:scenarioId", validate(schemas), async (req, res) => {
    const { params, query } = getInput<typeof schemas>(res);
    res.json(await deps.service.get(currentUser(req), params.scenarioId, query.limit));
  });
  return router;
}
