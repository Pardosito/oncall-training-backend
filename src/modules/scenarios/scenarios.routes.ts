import { Router } from "express";
import { notFound } from "../../platform/errors.js";
import { getInput, validate } from "../../platform/http/validate.js";
import type { ScenariosRepo } from "./scenarios.repo.js";
import { ScenarioParamsSchema } from "./scenarios.schemas.js";
import { toPublic, toSummary } from "./scenarios.views.js";

const getSchemas = { params: ScenarioParamsSchema };

export function scenariosRouter(deps: { scenarios: ScenariosRepo }): Router {
  const router = Router();

  router.get("/scenarios", async (_req, res) => {
    res.json((await deps.scenarios.list()).map(toSummary));
  });

  router.get("/scenarios/:scenarioId", validate(getSchemas), async (_req, res) => {
    const { params } = getInput<typeof getSchemas>(res);
    const scenario = await deps.scenarios.get(params.scenarioId);
    if (!scenario) throw notFound("Scenario not found.");
    res.json(toPublic(scenario));
  });

  return router;
}
