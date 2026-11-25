import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { createFixedClock } from "../../platform/clock.js";
import { createLogger } from "../../platform/logger.js";
import { bodyOf, errorOf } from "../../test-support/http.js";
import { ordersDownScenario } from "../../test-support/scenarios.js";
import { T0 } from "../../test-support/sessions.js";
import { createAuthMiddleware } from "../auth/index.js";
import { createFakeOrchestration } from "../orchestration/index.js";
import { createStaticScenariosRepo } from "../scenarios/index.js";
import { createInMemorySessionsRepo } from "./sessions.repo.js";
import { sessionsRouter } from "./sessions.routes.js";
import { createSessionsService } from "./sessions.service.js";

function makeApp() {
  const logger = createLogger({ level: "silent" });
  const service = createSessionsService({
    sessions: createInMemorySessionsRepo(),
    scenarios: createStaticScenariosRepo([ordersDownScenario()]),
    orchestration: createFakeOrchestration().orchestration,
    clock: createFixedClock(T0),
    logger,
    namespace: "mock",
  });
  return createApp({
    logger,
    readinessChecks: [],
    auth: createAuthMiddleware({ mode: "dev", logger }),
    routers: [sessionsRouter({ service })],
  });
}

describe("sessions routes", () => {
  it("POST /api/sessions → 201, then GET returns the view to its owner only", async () => {
    const app = makeApp();
    const created = await request(app)
      .post("/api/sessions")
      .set("x-dev-user", "user-a:alice")
      .send({ scenarioId: "orders-down" });
    expect(created.status).toBe(201);
    const { sessionId } = bodyOf<{ sessionId: string }>(created);

    const own = await request(app).get(`/api/sessions/${sessionId}`).set("x-dev-user", "user-a");
    expect(own.status).toBe(200);
    expect(bodyOf(own)).toEqual({
      sessionId,
      scenarioId: "orders-down",
      state: "STARTING",
      createdAt: T0.toISOString(),
      wrongActions: 0,
      actionsCount: 0,
    });

    const other = await request(app).get(`/api/sessions/${sessionId}`).set("x-dev-user", "user-b");
    expect(other.status).toBe(404);
  });

  it("GET /api/me/sessions lists only the caller's sessions and validates the query", async () => {
    const app = makeApp();
    const created = await request(app)
      .post("/api/sessions")
      .set("x-dev-user", "user-a")
      .send({ scenarioId: "orders-down" });
    const { sessionId } = bodyOf<{ sessionId: string }>(created);

    const mine = await request(app).get("/api/me/sessions?limit=5").set("x-dev-user", "user-a");
    expect(mine.status).toBe(200);
    expect(bodyOf<{ items: { sessionId: string }[] }>(mine).items.map((s) => s.sessionId)).toEqual([
      sessionId,
    ]);

    const theirs = await request(app).get("/api/me/sessions").set("x-dev-user", "user-b");
    expect(bodyOf(theirs)).toEqual({ items: [] });

    const bad = await request(app).get("/api/me/sessions?limit=0").set("x-dev-user", "user-a");
    expect(bad.status).toBe(400);
    const badCursor = await request(app)
      .get("/api/me/sessions?cursor=nope")
      .set("x-dev-user", "user-a");
    expect(badCursor.status).toBe(400);
  });

  it("returns 409 SESSION_BUSY for a second start", async () => {
    const app = makeApp();
    const start = (user: string) =>
      request(app)
        .post("/api/sessions")
        .set("x-dev-user", user)
        .send({ scenarioId: "orders-down" });

    expect((await start("user-a")).status).toBe(201);
    const busy = await start("user-b");

    expect(busy.status).toBe(409);
    expect(errorOf(busy)).toMatchObject({ code: "SESSION_BUSY" });
    expect(errorOf(busy).details).toHaveProperty("retryAfterSeconds");
  });

  it("validates the body and the session id", async () => {
    const app = makeApp();
    const noBody = await request(app).post("/api/sessions").set("x-dev-user", "u").send({});
    expect(noBody.status).toBe(400);
    const badId = await request(app).get("/api/sessions/not-a-ulid").set("x-dev-user", "u");
    expect(badId.status).toBe(400);
  });

  it("requires auth", async () => {
    const res = await request(makeApp()).post("/api/sessions").send({ scenarioId: "orders-down" });
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown scenario", async () => {
    const res = await request(makeApp())
      .post("/api/sessions")
      .set("x-dev-user", "u")
      .send({ scenarioId: "nope" });
    expect(res.status).toBe(404);
  });
});
