import { Router } from "express";
import { getInput, validate } from "../../platform/http/validate.js";
import { currentUser } from "../auth/index.js";
import { SessionParamsSchema } from "../sessions/index.js";
import { ActionRequestSchema, LogsQuerySchema } from "./actions.schemas.js";
import type { ActionsService } from "./actions.service.js";

const submitSchemas = { params: SessionParamsSchema, body: ActionRequestSchema };
const abandonSchemas = { params: SessionParamsSchema };
const logsSchemas = { params: SessionParamsSchema, query: LogsQuerySchema };

export function actionsRouter(deps: { service: ActionsService }): Router {
  const router = Router();

  router.post("/sessions/:sessionId/actions", validate(submitSchemas), async (req, res) => {
    const { params, body } = getInput<typeof submitSchemas>(res);
    const actionId = await deps.service.submit(currentUser(req), params.sessionId, body);
    res.status(202).json({ actionId });
  });

  router.post("/sessions/:sessionId/abandon", validate(abandonSchemas), async (req, res) => {
    const { params } = getInput<typeof abandonSchemas>(res);
    const actionId = await deps.service.abandon(currentUser(req), params.sessionId);
    res.status(202).json({ actionId });
  });

  router.get("/sessions/:sessionId/logs", validate(logsSchemas), async (req, res) => {
    const { params, query } = getInput<typeof logsSchemas>(res);
    res.json(await deps.service.logs(currentUser(req), params.sessionId, query.service));
  });

  return router;
}
