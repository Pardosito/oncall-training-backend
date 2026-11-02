import { describe, expect, it } from "vitest";
import type { Session } from "../sessions/index.js";
import {
  availableActionsFor,
  buildSnapshot,
  eventsFromSession,
  serviceHealth,
} from "./dashboard.builder.js";
import { DashboardSnapshotSchema } from "./dashboard.schemas.js";
import { createInMemoryHealthStreakStore, isResolved } from "./resolution.js";

const scenario = {
  targets: ["gateway", "orders", "worker-svc"],
  availableActions: ["ACKNOWLEDGE", "VIEW_LOGS", "RESTART_DEPLOYMENT", "SCALE_DEPLOYMENT"] as (
    "ACKNOWLEDGE" | "VIEW_LOGS" | "RESTART_DEPLOYMENT" | "SCALE_DEPLOYMENT"
  )[],
};

const session: Session = {
  userId: "user-1",
  sessionId: "01JBQ4ZJ8V2N7K3M5P6R8S9T0W",
  username: "ian",
  scenarioId: "orders-down",
  state: "INCIDENT_ACTIVE",
  createdAt: "2026-11-05T18:00:00.000Z",
  updatedAt: "2026-11-05T18:00:20.000Z",
  faultInjectedAt: "2026-11-05T18:00:20.000Z",
  wrongActions: 0,
  actionsCount: 0,
};

describe("serviceHealth", () => {
  it.each([
    ["no deployment", undefined, { healthy: true }, "down"],
    ["0 ready", { desiredReplicas: 2, readyReplicas: 0 }, { healthy: true }, "down"],
    ["failed check", { desiredReplicas: 2, readyReplicas: 2 }, { healthy: false }, "down"],
    ["no check", { desiredReplicas: 2, readyReplicas: 2 }, undefined, "down"],
    ["partly ready", { desiredReplicas: 2, readyReplicas: 1 }, { healthy: true }, "degraded"],
    [
      "slow",
      { desiredReplicas: 1, readyReplicas: 1 },
      { healthy: true, latencyMs: 1500 },
      "degraded",
    ],
    [
      "all good",
      { desiredReplicas: 1, readyReplicas: 1 },
      { healthy: true, latencyMs: 12 },
      "healthy",
    ],
  ] as const)("%s → %s", (_name, deployment, check, expected) => {
    expect(serviceHealth(deployment, check)).toBe(expected);
  });
});

describe("buildSnapshot", () => {
  const now = new Date("2026-11-05T18:01:00.000Z");
  const snapshot = buildSnapshot({
    session,
    scenario,
    deployments: [
      { name: "gateway", desiredReplicas: 1, readyReplicas: 1 },
      { name: "orders", desiredReplicas: 0, readyReplicas: 0 },
      { name: "worker-svc", desiredReplicas: 1, readyReplicas: 1 },
      { name: "unrelated", desiredReplicas: 1, readyReplicas: 1 },
    ],
    pods: [
      {
        name: "gateway-abc",
        deployment: "gateway",
        phase: "Running",
        ready: true,
        restarts: 1,
        startedAt: "2026-11-05T17:00:00.000Z",
      },
    ],
    health: {
      gateway: { healthy: false },
      orders: { healthy: false },
      "worker-svc": { healthy: true, latencyMs: 3.6 },
    },
    events: eventsFromSession(session),
    now,
  });

  it("matches the DashboardSnapshot schema", () => {
    expect(DashboardSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("includes only the scenario's targets, in scenario order", () => {
    expect(snapshot.services.map((service) => service.name)).toEqual(scenario.targets);
  });

  it("maps health, replicas, latency and pods", () => {
    expect(snapshot.services[0]).toMatchObject({ name: "gateway", health: "down" });
    expect(snapshot.services[0]?.pods).toEqual([
      { name: "gateway-abc", phase: "Running", ready: true, restarts: 1, ageSeconds: 3660 },
    ]);
    expect(snapshot.services[1]).toMatchObject({
      name: "orders",
      readyReplicas: 0,
      health: "down",
    });
    expect(snapshot.services[2]).toMatchObject({ health: "healthy", latencyMs: 4 });
  });

  it("counts elapsed time from the fault", () => {
    expect(snapshot.elapsedSeconds).toBe(40);
  });

  it("counts from creation before the fault and stops at the end", () => {
    const starting = buildSnapshot({
      session: { ...session, state: "STARTING", faultInjectedAt: undefined },
      scenario,
      deployments: [],
      pods: [],
      health: {},
      events: [],
      now,
    });
    expect(starting.elapsedSeconds).toBe(60);

    const ended = buildSnapshot({
      session: { ...session, state: "RESOLVED", endedAt: "2026-11-05T18:00:50.000Z" },
      scenario,
      deployments: [],
      pods: [],
      health: {},
      events: [],
      now,
    });
    expect(ended.elapsedSeconds).toBe(30);
  });
});

describe("availableActionsFor", () => {
  it("offers only ACKNOWLEDGE before the fault, all during, none after", () => {
    expect(availableActionsFor({ state: "STARTING" }, scenario)).toEqual(["ACKNOWLEDGE"]);
    expect(availableActionsFor({ state: "INCIDENT_ACTIVE" }, scenario)).toEqual(
      scenario.availableActions,
    );
    expect(availableActionsFor({ state: "RESOLVED" }, scenario)).toEqual([]);
    expect(availableActionsFor({ state: "FAILED" }, scenario)).toEqual([]);
  });
});

describe("eventsFromSession", () => {
  it("lists the session's milestones newest first", () => {
    const events = eventsFromSession({
      ...session,
      state: "RESOLVED",
      acknowledgedAt: "2026-11-05T18:00:30.000Z",
      endedAt: "2026-11-05T18:02:00.000Z",
      score: 880,
    });
    expect(events.map((event) => event.type)).toEqual([
      "RESOLVED",
      "ACKNOWLEDGED",
      "FAULT_INJECTED",
      "SESSION_STARTED",
    ]);
    expect(events[0]?.summary).toBe("Resolved, score 880");
  });

  it("explains a failure", () => {
    const events = eventsFromSession({
      ...session,
      state: "FAILED",
      endedAt: "2026-11-05T18:10:20.000Z",
      failureReason: "TIMEOUT",
    });
    expect(events[0]).toMatchObject({ type: "FAILED", summary: "Session failed (timeout)" });
  });
});

describe("resolution", () => {
  it("needs an active incident, a valid fix and two healthy checks", () => {
    const fix = "2026-11-05T18:01:00.000Z";
    expect(
      isResolved({ state: "INCIDENT_ACTIVE", validFixAppliedAt: fix, consecutiveHealthy: 2 }),
    ).toBe(true);
    expect(
      isResolved({ state: "INCIDENT_ACTIVE", validFixAppliedAt: fix, consecutiveHealthy: 1 }),
    ).toBe(false);
    expect(isResolved({ state: "INCIDENT_ACTIVE", consecutiveHealthy: 5 })).toBe(false);
    expect(isResolved({ state: "STARTING", validFixAppliedAt: fix, consecutiveHealthy: 5 })).toBe(
      false,
    );
    expect(isResolved({ state: "RESOLVED", validFixAppliedAt: fix, consecutiveHealthy: 5 })).toBe(
      false,
    );
  });

  it("does not resolve on flapping (healthy, unhealthy, healthy)", async () => {
    const streaks = createInMemoryHealthStreakStore();
    const id = session.sessionId;

    await streaks.record(id, true);
    await streaks.record(id, false);
    const streak = await streaks.record(id, true);

    expect(streak).toBe(1);
    expect(
      isResolved({ state: "INCIDENT_ACTIVE", validFixAppliedAt: "x", consecutiveHealthy: streak }),
    ).toBe(false);
  });

  it("keeps streaks per session and clears them", async () => {
    const streaks = createInMemoryHealthStreakStore();
    await streaks.record("a", true);
    await streaks.record("a", true);
    await streaks.record("b", true);

    expect(await streaks.record("a", true)).toBe(3);
    await streaks.clear("a");
    expect(await streaks.record("a", true)).toBe(1);
    expect(await streaks.record("b", true)).toBe(2);
  });
});
