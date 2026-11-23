import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { createFixedClock } from "../../platform/clock.js";
import { createLogger } from "../../platform/logger.js";
import { bodyOf } from "../../test-support/http.js";
import { ordersDownScenario } from "../../test-support/scenarios.js";
import { makeSession, T0 } from "../../test-support/sessions.js";
import { createAuthMiddleware } from "../auth/index.js";
import { buildEvent, createInMemoryEventLog, eventIds, type EventLog } from "../events/index.js";
import { createFakeMockCluster, type MockClusterGateway } from "../mock-cluster/index.js";
import { createStaticScenariosRepo } from "../scenarios/index.js";
import { createInMemorySessionsRepo, type Session } from "../sessions/index.js";
import { allServicesUp, observeMockSystem } from "./dashboard.observe.js";
import { dashboardRouter } from "./dashboard.routes.js";
import { DashboardSnapshotSchema, type DashboardSnapshot } from "./dashboard.schemas.js";
import { createDashboardService } from "./dashboard.service.js";
import { createInMemorySnapshotStore, type SnapshotStore } from "./dashboard.snapshots.js";

const scenario = ordersDownScenario();
let sessions: ReturnType<typeof createInMemorySessionsRepo>;
let cluster: ReturnType<typeof createFakeMockCluster>;

function makeApp(
  gateway: MockClusterGateway = cluster,
  events?: EventLog,
  snapshots?: SnapshotStore,
) {
  const logger = createLogger({ level: "silent" });
  const clock = createFixedClock(T0);
  clock.advance(90);
  const service = createDashboardService({
    sessions,
    scenarios: createStaticScenariosRepo([scenario]),
    cluster: gateway,
    clock,
    logger,
    ...(events ? { events } : {}),
    ...(snapshots ? { snapshots } : {}),
  });
  return createApp({
    logger,
    readinessChecks: [],
    auth: createAuthMiddleware({ mode: "dev", logger }),
    routers: [dashboardRouter({ service })],
  });
}

beforeEach(() => {
  sessions = createInMemorySessionsRepo();
  cluster = createFakeMockCluster({ baseline: scenario.baseline });
});

async function given(overrides: Partial<Session>): Promise<Session> {
  const session = makeSession(overrides);
  await sessions.create(session);
  return session;
}

async function snapshot(app: ReturnType<typeof makeApp>, session: Session, user = "user-a") {
  const res = await request(app)
    .get(`/api/sessions/${session.sessionId}/dashboard`)
    .set("x-dev-user", user);
  return { status: res.status, body: bodyOf<DashboardSnapshot>(res), headers: res.headers };
}

describe("GET /api/sessions/:id/dashboard with stored snapshots", () => {
  const silent = createLogger({ level: "silent" });
  const faultAt = new Date(T0.getTime() + 20_000).toISOString();
  const stored = (session: Session, state: Session["state"]): DashboardSnapshot => ({
    sessionId: session.sessionId,
    state,
    generatedAt: new Date(T0.getTime() + 88_000).toISOString(),
    elapsedSeconds: 68,
    services: [],
    recentEvents: [],
    availableActions: [],
  });

  it("serves the monitor's snapshot without reading the cluster", async () => {
    const session = await given({ state: "INCIDENT_ACTIVE", faultInjectedAt: faultAt });
    const snapshots = createInMemorySnapshotStore(silent);
    await snapshots.put(stored(session, "INCIDENT_ACTIVE"));
    const listDeployments = vi.fn(() => cluster.listDeployments());

    const { body } = await snapshot(
      makeApp({ ...cluster, listDeployments }, undefined, snapshots),
      session,
    );

    expect(body).toEqual(stored(session, "INCIDENT_ACTIVE"));
    expect(listDeployments).not.toHaveBeenCalled();
  });

  it("builds it live when the stored one is from before a state change, missing or invalid", async () => {
    const session = await given({ state: "INCIDENT_ACTIVE", faultInjectedAt: faultAt });
    const snapshots = createInMemorySnapshotStore(silent);
    await snapshots.put(stored(session, "STARTING"));
    const app = makeApp(cluster, undefined, snapshots);
    expect((await snapshot(app, session)).body.elapsedSeconds).toBe(70);

    snapshots.putRaw(session.sessionId, JSON.stringify({ sessionId: session.sessionId }));
    expect((await snapshot(app, session)).body.services).toHaveLength(3);

    await snapshots.clear(session.sessionId);
    expect((await snapshot(app, session)).body.services).toHaveLength(3);
  });

  it("ignores it for an ended session and on a Redis error", async () => {
    const ended = await given({ state: "RESOLVED", faultInjectedAt: faultAt, endedAt: faultAt });
    const snapshots = createInMemorySnapshotStore(silent);
    await snapshots.put(stored(ended, "RESOLVED"));
    expect((await snapshot(makeApp(cluster, undefined, snapshots), ended)).body.generatedAt).toBe(
      new Date(T0.getTime() + 90_000).toISOString(),
    );

    const active = await given({ state: "INCIDENT_ACTIVE", faultInjectedAt: faultAt });
    const failing = { ...snapshots, get: () => Promise.reject(new Error("redis down")) };
    const res = await snapshot(makeApp(cluster, undefined, failing), active);
    expect(res.status).toBe(200);
    expect(res.body.services).toHaveLength(3);
  });
});

describe("GET /api/sessions/:id/dashboard recentEvents", () => {
  const faultAt = new Date(T0.getTime() + 20_000).toISOString();

  it("come from the event log, newest first, with summaries", async () => {
    const session = await given({ state: "INCIDENT_ACTIVE", faultInjectedAt: faultAt });
    const events = createInMemoryEventLog(createLogger({ level: "silent" }));
    const ids = eventIds(session);
    await events.append(session.sessionId, buildEvent({ ts: T0, ...ids, type: "SESSION_STARTED" }));
    await events.append(
      session.sessionId,
      buildEvent({ ts: faultAt, ...ids, type: "FAULT_INJECTED", target: "orders" }),
    );
    await events.append(
      session.sessionId,
      buildEvent({
        ts: new Date(T0.getTime() + 40_000),
        ...ids,
        type: "ACTION",
        action: "SCALE_DEPLOYMENT",
        target: "orders",
        params: { replicas: 2 },
        valid: true,
      }),
    );

    const { body } = await snapshot(makeApp(cluster, events), session);

    expect(body.recentEvents.map((e) => e.summary)).toEqual([
      "Scaled orders to 2",
      "Incident started",
      "Session started",
    ]);
  });

  it("fall back to the session item when the buffer is empty or Redis fails", async () => {
    const session = await given({ state: "INCIDENT_ACTIVE", faultInjectedAt: faultAt });
    const events = createInMemoryEventLog(createLogger({ level: "silent" }));

    const empty = await snapshot(makeApp(cluster, events), session);
    expect(empty.body.recentEvents.map((e) => e.type)).toEqual([
      "FAULT_INJECTED",
      "SESSION_STARTED",
    ]);

    const failing = { ...events, recent: () => Promise.reject(new Error("redis down")) };
    const down = await snapshot(makeApp(cluster, failing), session);
    expect(down.status).toBe(200);
    expect(down.body.recentEvents).toEqual(empty.body.recentEvents);
  });
});

describe("GET /api/sessions/:id/dashboard", () => {
  it("builds a live snapshot that shows the fault", async () => {
    const session = await given({
      state: "INCIDENT_ACTIVE",
      faultInjectedAt: new Date(T0.getTime() + 20_000).toISOString(),
    });
    cluster.applyFault({ type: "SCALE_TO_ZERO", target: "orders" });

    const { status, body, headers } = await snapshot(makeApp(), session);

    expect(status).toBe(200);
    expect(headers["cache-control"]).toBe("no-store");
    expect(DashboardSnapshotSchema.parse(body)).toBeDefined();
    expect(body.elapsedSeconds).toBe(70);
    expect(body.services.map((s) => [s.name, s.health])).toEqual([
      ["gateway", "down"],
      ["orders", "down"],
      ["worker-svc", "healthy"],
    ]);
    expect(body.availableActions).toEqual(scenario.availableActions);
    expect(body.stale).toBeUndefined();
  });

  it("returns a minimal final snapshot for a terminal session", async () => {
    const session = await given({
      state: "RESOLVED",
      endedAt: new Date(T0.getTime() + 60_000).toISOString(),
      score: 900,
    });
    const { body } = await snapshot(makeApp(), session);
    expect(body).toMatchObject({ state: "RESOLVED", services: [], availableActions: [] });
    expect(body.recentEvents[0]).toMatchObject({ type: "RESOLVED" });
  });

  it("returns a stale minimal snapshot when the cluster can't be read", async () => {
    const broken: MockClusterGateway = {
      ...cluster,
      listDeployments: () => Promise.reject(new Error("k8s down")),
    };
    const session = await given({ state: "STARTING" });
    const { status, body } = await snapshot(makeApp(broken), session);
    expect(status).toBe(200);
    expect(body).toMatchObject({ stale: true, services: [], availableActions: ["ACKNOWLEDGE"] });
  });

  it("returns 404 for someone else's session", async () => {
    const session = await given({ state: "STARTING" });
    expect((await snapshot(makeApp(), session, "user-b")).status).toBe(404);
  });
});

describe("allServicesUp", () => {
  it("is false while any target is down and true once fixed", async () => {
    cluster.applyFault({ type: "SCALE_TO_ZERO", target: "orders" });
    expect(
      allServicesUp(await observeMockSystem(cluster, scenario.targets), scenario.targets),
    ).toBe(false);
    await cluster.scale("orders", 1);
    expect(
      allServicesUp(await observeMockSystem(cluster, scenario.targets), scenario.targets),
    ).toBe(true);
  });
});
