import { beforeEach, describe, expect, it } from "vitest";
import { createFixedClock } from "../platform/clock.js";
import { createLogger } from "../platform/logger.js";
import { ordersDownScenario } from "../test-support/scenarios.js";
import { makeSession, T0 } from "../test-support/sessions.js";
import type { QueueMessage } from "../modules/actions/index.js";
import { createInMemoryHealthStreakStore } from "../modules/dashboard/index.js";
import { createFakeMockCluster } from "../modules/mock-cluster/index.js";
import { createFakeOrchestration } from "../modules/orchestration/index.js";
import { createStaticScenariosRepo } from "../modules/scenarios/index.js";
import { createInMemorySessionsRepo, type Session } from "../modules/sessions/index.js";
import { createMessageHandler } from "./handlers.js";

const scenario = ordersDownScenario();
const FAULT_AT = new Date(T0.getTime() + 20_000).toISOString();

let sessions: ReturnType<typeof createInMemorySessionsRepo>;
let cluster: ReturnType<typeof createFakeMockCluster>;
let fake: ReturnType<typeof createFakeOrchestration>;
let streaks: ReturnType<typeof createInMemoryHealthStreakStore>;
let clock: ReturnType<typeof createFixedClock>;
let handle: ReturnType<typeof createMessageHandler>;
let session: Session;

beforeEach(async () => {
  sessions = createInMemorySessionsRepo();
  cluster = createFakeMockCluster({ baseline: scenario.baseline });
  fake = createFakeOrchestration();
  streaks = createInMemoryHealthStreakStore();
  clock = createFixedClock(T0);
  clock.advance(60);
  handle = createMessageHandler({
    sessions,
    scenarios: createStaticScenariosRepo([scenario]),
    cluster,
    orchestration: fake.orchestration,
    streaks,
    clock,
    logger: createLogger({ level: "silent" }),
  });
  session = makeSession({ state: "INCIDENT_ACTIVE", faultInjectedAt: FAULT_AT });
  await sessions.create(session);
});

let n = 0;
function user(action: Record<string, unknown>, target: Session = session): QueueMessage {
  return {
    kind: "USER",
    actionId: `01JC0000000000000000000${String(++n).padStart(3, "0")}`,
    sessionId: target.sessionId,
    userId: target.userId,
    requestedAt: new Date(T0.getTime() + 45_000).toISOString(),
    ...action,
  } as QueueMessage;
}

const deployment = async (name: string) =>
  (await cluster.listDeployments()).find((d) => d.name === name);

describe("ACKNOWLEDGE", () => {
  it("sets acknowledgedAt from requestedAt once and counts the action", async () => {
    await handle(user({ type: "ACKNOWLEDGE" }));
    await handle(user({ type: "ACKNOWLEDGE" }));

    expect(await sessions.get(session)).toMatchObject({
      acknowledgedAt: new Date(T0.getTime() + 45_000).toISOString(),
      actionsCount: 2,
      wrongActions: 0,
    });
  });

  it("does not start TTD before the fault", async () => {
    const starting = makeSession({ state: "STARTING" });
    await sessions.create(starting);

    await handle(user({ type: "ACKNOWLEDGE" }, starting));

    const stored = await sessions.get(starting);
    expect(stored?.acknowledgedAt).toBeUndefined();
    expect(stored?.actionsCount).toBe(1);
  });
});

describe("SCALE_DEPLOYMENT / RESTART_DEPLOYMENT", () => {
  beforeEach(() => cluster.applyFault({ type: "SCALE_TO_ZERO", target: "orders" }));

  it("applies a valid fix and records validFixAppliedAt", async () => {
    await handle(user({ type: "SCALE_DEPLOYMENT", target: "orders", params: { replicas: 2 } }));

    expect((await deployment("orders"))?.desiredReplicas).toBe(2);
    expect(await sessions.get(session)).toMatchObject({
      validFixAppliedAt: clock.now().toISOString(),
      actionsCount: 1,
      wrongActions: 0,
    });
  });

  it("applies a wrong action and penalizes it", async () => {
    await handle(user({ type: "RESTART_DEPLOYMENT", target: "gateway" }));

    const stored = await sessions.get(session);
    expect(stored).toMatchObject({ actionsCount: 1, wrongActions: 1 });
    expect(stored?.validFixAppliedAt).toBeUndefined();
  });

  it("skips an action on a target outside the scenario without touching the cluster", async () => {
    await handle(user({ type: "RESTART_DEPLOYMENT", target: "kube-dns" }));
    expect(await sessions.get(session)).toMatchObject({ actionsCount: 0, wrongActions: 0 });
  });

  it("skips actions once the session ended", async () => {
    await sessions.transition(session, { from: "INCIDENT_ACTIVE", to: "FAILED", at: clock.now() });

    await handle(user({ type: "SCALE_DEPLOYMENT", target: "orders", params: { replicas: 1 } }));

    expect((await deployment("orders"))?.desiredReplicas).toBe(0);
  });

  it("rethrows a cluster error so SQS retries", async () => {
    const failing = createMessageHandler({
      sessions,
      scenarios: createStaticScenariosRepo([scenario]),
      cluster: { ...cluster, scale: () => Promise.reject(new Error("forbidden")) },
      orchestration: fake.orchestration,
      streaks,
      clock,
      logger: createLogger({ level: "silent" }),
    });
    await expect(
      failing(user({ type: "SCALE_DEPLOYMENT", target: "orders", params: { replicas: 1 } })),
    ).rejects.toThrow("forbidden");
    expect((await sessions.get(session))?.actionsCount).toBe(0);
  });
});

describe("ABANDON", () => {
  it("fails the session from its current state", async () => {
    await handle(user({ type: "ABANDON" }));
    expect(fake.calls).toMatchObject([
      { method: "failTask", input: { from: "INCIDENT_ACTIVE", reason: "ABANDONED" } },
    ]);
  });
});

describe("SESSION_ENDED", () => {
  it("resets every deployment to the baseline and clears the health streak", async () => {
    cluster.applyFault({ type: "SCALE_TO_ZERO", target: "orders" });
    await streaks.record(session.sessionId, true);

    await handle({
      kind: "SYSTEM",
      type: "SESSION_ENDED",
      sessionId: session.sessionId,
      userId: session.userId,
      outcome: "FAILED",
      reason: "TIMEOUT",
    });

    expect((await deployment("orders"))?.desiredReplicas).toBe(2);
    expect(await streaks.record(session.sessionId, true)).toBe(1);
  });
});

it("acks messages for unknown sessions", async () => {
  await expect(
    handle(user({ type: "ACKNOWLEDGE" }, makeSession({ userId: "ghost" }))),
  ).resolves.toBeUndefined();
});
