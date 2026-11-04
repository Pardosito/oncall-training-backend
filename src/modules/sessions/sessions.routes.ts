import { Router } from "express";
import { getInput, validate } from "../../platform/http/validate.js";
import { currentUser } from "../auth/index.js";
import { CreateSessionBodySchema, SessionParamsSchema } from "./sessions.schemas.js";
import type { SessionsService } from "./sessions.service.js";
import { toSessionView } from "./sessions.transitions.js";

const createSchemas = { body: CreateSessionBodySchema };
const getSchemas = { params: SessionParamsSchema };

export function sessionsRouter(deps: { service: SessionsService }): Router {
  const router = Router();

  router.post("/sessions", validate(createSchemas), async (req, res) => {
    const { body } = getInput<typeof createSchemas>(res);
    const session = await deps.service.startSession(currentUser(req), body.scenarioId);
    res.status(201).json({ sessionId: session.sessionId });
  });

  router.get("/sessions/:sessionId", validate(getSchemas), async (req, res) => {
    const { params } = getInput<typeof getSchemas>(res);
    res.json(toSessionView(await deps.service.getSession(currentUser(req), params.sessionId)));
  });

  return router;
}
