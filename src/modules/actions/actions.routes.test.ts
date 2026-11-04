import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { createFixedClock } from "../../platform/clock.js";
import { createLogger } from "../../platform/logger.js";
import { createInMemoryQueue } from "../../platform/queue.js";
import { bodyOf, errorOf } from "../../test-support/http.js";
import { ordersDownScenario } from "../../test-support/scenarios.js";
import { makeSession, T0 } from "../../test-support/sessions.js";
import { createAuthMiddleware } from "../auth/index.js";
import { createFakeMockCluster } from "../mock-cluster/index.js";
import { createStaticScenariosRepo } from "../scenarios/index.js";
import { createInMemorySessionsRepo, type Session } from "../sessions/index.js";
import { actionsRouter } from "./actions.routes.js";
import { QueueMessageSchema } from "./actions.schemas.js";
import { createActionsService } from "./actions.service.js";

const QUEUE = "user-actions.fifo";
const scenario = ordersDownScenario();

let queue: ReturnType<typeof createInMemoryQueue>;
let sessions: ReturnType<typeof createInMemorySessionsRepo>;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  const logger = createLogger({ level: "silent" });
  queue = createInMemoryQueue();
  sessions = createInMemorySessionsRepo();
  const service = createActionsService({
    sessions,
    scenarios: createStaticScenariosRepo([scenario]),
    queue,
    userActionsQueueUrl: QUEUE,
    cluster: createFakeMockCluster({ baseline: scenario.baseline }),
    clock: createFixedClock(T0),
    newId: () => "01JC00000000000000000ACT01",
  });
  app = createApp({
    logger,
    readinessChecks: [],
    auth: createAuthMiddleware({ mode: "dev", logger }),
    routers: [actionsRouter({ service })],
  });
});

async function given(overrides: Partial<Session>): Promise<Session> {
  const session = makeSession(overrides);
  await sessions.create(session);
  return session;
}

const asUser = (req: request.Test, user = "user-a") => req.set("x-dev-user", user);

describe("POST /api/sessions/:id/actions", () => {
  it("queues a valid action as a USER message (FIFO group = session)", async () => {
    const session = await given({ state: "INCIDENT_ACTIVE" });

    const res = await asUser(
      request(app)
        .post(`/api/sessions/${session.sessionId}/actions`)
        .send({ type: "SCALE_DEPLOYMENT", target: "orders", params: { replicas: 2 } }),
    );

    expect(res.status).toBe(202);
    expect(bodyOf(res)).toEqual({ actionId: "01JC00000000000000000ACT01" });
    expect(queue.pending(QUEUE).map((m) => QueueMessageSchema.parse(m))).toEqual([
      {
        kind: "USER",
        type: "SCALE_DEPLOYMENT",
        target: "orders",
        params: { replicas: 2 },
        actionId: "01JC00000000000000000ACT01",
        sessionId: session.sessionId,
        userId: "user-a",
        requestedAt: T0.toISOString(),
      },
    ]);
  });

  it("accepts ACKNOWLEDGE while STARTING", async () => {
    const session = await given({ state: "STARTING" });
    const res = await asUser(
      request(app).post(`/api/sessions/${session.sessionId}/actions`).send({ type: "ACKNOWLEDGE" }),
    );
    expect(res.status).toBe(202);
  });

  it("returns 422 ACTION_NOT_ALLOWED for a target outside the scenario", async () => {
    const session = await given({ state: "INCIDENT_ACTIVE" });
    const res = await asUser(
      request(app)
        .post(`/api/sessions/${session.sessionId}/actions`)
        .send({ type: "RESTART_DEPLOYMENT", target: "kube-dns" }),
    );
    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe("ACTION_NOT_ALLOWED");
    expect(queue.pending(QUEUE)).toEqual([]);
  });

  it("returns 409 SESSION_NOT_ACTIVE for a fix before the fault or after the end", async () => {
    for (const state of ["STARTING", "RESOLVED"] as const) {
      const session = await given({ state });
      const res = await asUser(
        request(app)
          .post(`/api/sessions/${session.sessionId}/actions`)
          .send({ type: "RESTART_DEPLOYMENT", target: "orders" }),
      );
      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe("SESSION_NOT_ACTIVE");
    }
  });

  it("returns 400 for replicas outside 1–3", async () => {
    const session = await given({ state: "INCIDENT_ACTIVE" });
    const res = await asUser(
      request(app)
        .post(`/api/sessions/${session.sessionId}/actions`)
        .send({ type: "SCALE_DEPLOYMENT", target: "orders", params: { replicas: 10 } }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 for someone else's session", async () => {
    const session = await given({ state: "INCIDENT_ACTIVE" });
    const res = await asUser(
      request(app).post(`/api/sessions/${session.sessionId}/actions`).send({ type: "ACKNOWLEDGE" }),
      "user-b",
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/sessions/:id/abandon", () => {
  it("queues ABANDON for an active session", async () => {
    const session = await given({ state: "INCIDENT_ACTIVE" });
    const res = await asUser(request(app).post(`/api/sessions/${session.sessionId}/abandon`));
    expect(res.status).toBe(202);
    expect(queue.pending(QUEUE)).toMatchObject([{ kind: "USER", type: "ABANDON" }]);
  });

  it("returns 409 once the session ended and 404 for another user", async () => {
    const ended = await given({ state: "FAILED" });
    expect(
      (await asUser(request(app).post(`/api/sessions/${ended.sessionId}/abandon`))).status,
    ).toBe(409);
    expect(
      (await asUser(request(app).post(`/api/sessions/${ended.sessionId}/abandon`), "user-b"))
        .status,
    ).toBe(404);
  });
});

describe("GET /api/sessions/:id/logs", () => {
  it("returns the service's log lines", async () => {
    const session = await given({ state: "INCIDENT_ACTIVE" });
    const res = await asUser(
      request(app).get(`/api/sessions/${session.sessionId}/logs?service=orders`),
    );
    expect(res.status).toBe(200);
    const body = bodyOf<{ service: string; lines: string[] }>(res);
    expect(body.service).toBe("orders");
    expect(Array.isArray(body.lines)).toBe(true);
  });

  it("returns 422 for a service outside the scenario and 409 before the fault", async () => {
    const active = await given({ state: "INCIDENT_ACTIVE" });
    const outside = await asUser(
      request(app).get(`/api/sessions/${active.sessionId}/logs?service=kube-dns`),
    );
    expect(outside.status).toBe(422);

    const starting = await given({ state: "STARTING" });
    const early = await asUser(
      request(app).get(`/api/sessions/${starting.sessionId}/logs?service=orders`),
    );
    expect(early.status).toBe(409);
  });

  it("requires the service query param", async () => {
    const session = await given({ state: "INCIDENT_ACTIVE" });
    const res = await asUser(request(app).get(`/api/sessions/${session.sessionId}/logs`));
    expect(res.status).toBe(400);
  });
});
