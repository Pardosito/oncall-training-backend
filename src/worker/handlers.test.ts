import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { createFixedClock } from "../platform/clock.js";
import { createInMemoryLock, type Lock } from "../platform/lock.js";
import { createLogger } from "../platform/logger.js";
import { ordersDownScenario } from "../test-support/scenarios.js";
import { makeSession, T0 } from "../test-support/sessions.js";
import type { QueueMessage } from "../modules/actions/index.js";
import { createInMemoryHealthStreakStore } from "../modules/dashboard/index.js";
import {
  buildEvent,
  createEventFlusher,
  createEventRecorder,
  createInMemoryEventLog,
  eventIds,
} from "../modules/events/index.js";
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

  it("doesn't reset while another session is running (late end of an abandoned one)", async () => {
    const old = makeSession({ sessionId: "01JC0000000000000000000OLD", state: "FAILED" });
    await sessions.create(old);
    cluster.applyFault({ type: "SCALE_TO_ZERO", target: "orders" }); // the running session's fault

    await handle({
      kind: "SYSTEM",
      type: "SESSION_ENDED",
      sessionId: old.sessionId,
      userId: old.userId,
      outcome: "FAILED",
      reason: "ABANDONED",
    });

    expect((await deployment("orders"))?.desiredReplicas).toBe(0);
  });
});

describe("SESSION_ENDED with the global lock", () => {
  let lock: Lock;
  const ended = (target: Session): QueueMessage => ({
    kind: "SYSTEM",
    type: "SESSION_ENDED",
    sessionId: target.sessionId,
    userId: target.userId,
    outcome: "FAILED",
    reason: "TIMEOUT",
  });
  beforeEach(() => {
    lock = createInMemoryLock(clock);
    handle = createMessageHandler({
      sessions,
      scenarios: createStaticScenariosRepo([scenario]),
      cluster,
      orchestration: fake.orchestration,
      streaks,
      clock,
      logger: createLogger({ level: "silent" }),
      lock,
    });
  });

  it("releases the session's lock after the reset", async () => {
    await lock.acquire(session.sessionId, 60_000);
    cluster.applyFault({ type: "SCALE_TO_ZERO", target: "orders" });

    await handle(ended(session));

    expect((await deployment("orders"))?.desiredReplicas).toBe(2);
    expect(await lock.holder()).toBeNull();
  });

  it("neither resets nor frees the lock of the session that started since (late SESSION_ENDED)", async () => {
    const old = makeSession({ sessionId: "01JC0000000000000000000OLD", state: "FAILED" });
    await sessions.create(old);
    await lock.acquire(session.sessionId, 60_000);
    cluster.applyFault({ type: "SCALE_TO_ZERO", target: "orders" }); // the running session's fault
    const scan = vi.spyOn(sessions, "findActive");

    await handle(ended(old));

    expect(await lock.holder()).toBe(session.sessionId);
    expect((await deployment("orders"))?.desiredReplicas).toBe(0);
    expect(scan).not.toHaveBeenCalled(); // the lock holder answers it, no DynamoDB scan
  });

  it("frees the lock at once for an abandon during the warmup (D-32)", async () => {
    const starting = makeSession({ sessionId: "01JC0000000000000000000STA", state: "STARTING" });
    await sessions.create(starting);
    await lock.acquire(starting.sessionId, 60_000);

    await handle(user({ type: "ABANDON" }, starting));

    expect(await lock.holder()).toBeNull();
  });

  it("keeps the lock for an abandon during the incident until SESSION_ENDED resets", async () => {
    await lock.acquire(session.sessionId, 60_000);

    await handle(user({ type: "ABANDON" }));

    expect(await lock.holder()).toBe(session.sessionId);
  });

  it("keeps the lock when the reset fails, so the retry resets before anyone starts", async () => {
    await lock.acquire(session.sessionId, 60_000);
    vi.spyOn(cluster, "scale").mockRejectedValue(new Error("k8s down"));
    cluster.applyFault({ type: "SCALE_TO_ZERO", target: "orders" });

    await expect(handle(ended(session))).rejects.toThrow("reset failed");

    expect(await lock.holder()).toBe(session.sessionId);
  });
});

describe("event log", () => {
  const logger = createLogger({ level: "silent" });
  let log: ReturnType<typeof createInMemoryEventLog>;
  let send: Mock;
  const ended = (target: Session, outcome: "RESOLVED" | "FAILED" = "FAILED"): QueueMessage => ({
    kind: "SYSTEM",
    type: "SESSION_ENDED",
    sessionId: target.sessionId,
    userId: target.userId,
    outcome,
    reason: outcome === "FAILED" ? "TIMEOUT" : null,
  });
  const types = async (target: Session = session) =>
    (await log.all(target.sessionId)).map((event) => event.type);
  /** The NDJSON lines of the n-th upload. */
  const uploaded = (call = 0) =>
    (send.mock.calls[call]?.[0] as { input: { Body: string; Key: string } }).input;
  const started = () =>
    log.append(
      session.sessionId,
      buildEvent({ ts: T0, ...eventIds(session), type: "SESSION_STARTED" }),
    );

  beforeEach(() => {
    log = createInMemoryEventLog(logger);
    send = vi.fn().mockResolvedValue({});
    handle = createMessageHandler({
      sessions,
      scenarios: createStaticScenariosRepo([scenario]),
      cluster,
      orchestration: fake.orchestration,
      streaks,
      clock,
      logger,
      events: {
        recorder: createEventRecorder({ events: log, logger }),
        log,
        flusher: createEventFlusher({ events: log, s3: { send }, bucket: "files", logger }),
      },
    });
  });

  it("records the first ACKNOWLEDGE at requestedAt, and only once", async () => {
    await handle(user({ type: "ACKNOWLEDGE" }));
    await handle(user({ type: "ACKNOWLEDGE" }));

    const events = await log.all(session.sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "ACKNOWLEDGED",
      ts: new Date(T0.getTime() + 45_000).toISOString(),
      user_id: session.userId,
      scenario_id: "orders-down",
    });
  });

  it("records each applied action with its params and whether it was a valid fix", async () => {
    cluster.applyFault({ type: "SCALE_TO_ZERO", target: "orders" });
    await handle(user({ type: "RESTART_DEPLOYMENT", target: "gateway" }));
    await handle(user({ type: "SCALE_DEPLOYMENT", target: "orders", params: { replicas: 2 } }));

    expect(await log.all(session.sessionId)).toMatchObject([
      {
        type: "ACTION",
        action: "RESTART_DEPLOYMENT",
        target: "gateway",
        params: null,
        valid: false,
      },
      {
        type: "ACTION",
        action: "SCALE_DEPLOYMENT",
        target: "orders",
        params: { replicas: 2 },
        valid: true,
      },
    ]);
  });

  it("records nothing for an action that no longer applies", async () => {
    await handle(user({ type: "SCALE_DEPLOYMENT", target: "nope", params: { replicas: 2 } }));
    expect(await types()).toEqual([]);
  });

  it("SESSION_ENDED (FAILED): adds FAILED, uploads the whole log, then clears the buffer", async () => {
    await started();
    await handle(ended(session));

    expect(send).toHaveBeenCalledTimes(1);
    const lines = uploaded().Body.trimEnd().split("\n");
    expect(lines.map((line) => (JSON.parse(line) as { type: string }).type)).toEqual([
      "SESSION_STARTED",
      "FAILED",
    ]);
    expect(uploaded().Key).toBe(`logs/year=2026/month=11/day=05/${session.sessionId}.ndjson`);
    expect(await types()).toEqual([]);
  });

  it("SESSION_ENDED (RESOLVED): no FAILED line", async () => {
    await started();
    await handle(ended(session, "RESOLVED"));
    expect(uploaded().Body.trimEnd().split("\n")).toHaveLength(1);
  });

  it("a redelivered SESSION_ENDED after the cleanup writes nothing (the log isn't replaced)", async () => {
    await started();
    await handle(ended(session));
    await handle(ended(session));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a failed reset keeps the buffer; the retry uploads the same log, with one FAILED line", async () => {
    await started();
    const scale = vi.spyOn(cluster, "scale").mockRejectedValueOnce(new Error("k8s down"));
    cluster.applyFault({ type: "SCALE_TO_ZERO", target: "orders" });

    await expect(handle(ended(session))).rejects.toThrow("reset failed");
    expect(await types()).toEqual(["SESSION_STARTED", "FAILED"]);

    scale.mockRestore();
    await handle(ended(session));
    expect(send).toHaveBeenCalledTimes(2);
    expect(uploaded(1).Body).toBe(uploaded(0).Body);
    expect(await types()).toEqual([]);
  });

  it("a failed upload throws before the reset, so the message is retried", async () => {
    await started();
    send.mockRejectedValueOnce(new Error("s3 down"));
    cluster.applyFault({ type: "SCALE_TO_ZERO", target: "orders" });

    await expect(handle(ended(session))).rejects.toThrow("s3 down");
    expect((await deployment("orders"))?.desiredReplicas).toBe(0);
    expect(await types()).toEqual(["SESSION_STARTED", "FAILED"]);
  });

  it("a late SESSION_ENDED flushes and clears its own log but leaves the running session alone", async () => {
    const old = makeSession({ sessionId: "01JC0000000000000000000OLD", state: "FAILED" });
    await sessions.create(old);
    await log.append(
      old.sessionId,
      buildEvent({ ts: T0, ...eventIds(old), type: "SESSION_STARTED" }),
    );
    await started();
    cluster.applyFault({ type: "SCALE_TO_ZERO", target: "orders" });

    await handle(ended(old));

    expect(uploaded().Key).toContain(old.sessionId);
    expect(await types(old)).toEqual([]);
    expect(await types()).toEqual(["SESSION_STARTED"]);
    expect((await deployment("orders"))?.desiredReplicas).toBe(0);
  });

  it("a Redis error while recording an action doesn't fail the action", async () => {
    cluster.applyFault({ type: "SCALE_TO_ZERO", target: "orders" });
    vi.spyOn(log, "append").mockRejectedValue(new Error("redis down"));

    await handle(user({ type: "SCALE_DEPLOYMENT", target: "orders", params: { replicas: 2 } }));

    expect((await deployment("orders"))?.desiredReplicas).toBe(2);
    expect((await sessions.get(session))?.validFixAppliedAt).toBeDefined();
  });
});

describe("AWAIT_FIX", () => {
  const awaitFix = (target: Session, taskToken = "token-1"): QueueMessage => ({
    kind: "SYSTEM",
    type: "AWAIT_FIX",
    sessionId: target.sessionId,
    userId: target.userId,
    taskToken,
  });

  it("stores the task token on an active session", async () => {
    await handle(awaitFix(session));

    expect(await sessions.getTaskToken(session)).toBe("token-1");
    expect(fake.calls).toEqual([]);
  });

  it("fails the task right away when the session already ended (abandoned in the warmup)", async () => {
    const ended = makeSession({
      sessionId: "01JC0000000000000000000END",
      state: "FAILED",
      failureReason: "ABANDONED",
    });
    await sessions.create(ended);

    await handle(awaitFix(ended, "token-2"));

    expect(await sessions.getTaskToken(ended)).toBeUndefined();
    expect(fake.calls).toEqual([
      {
        method: "failTask",
        input: expect.objectContaining({ taskToken: "token-2", reason: "ABANDONED" }) as unknown,
      },
    ]);
  });

  it("fails the task for an unknown session", async () => {
    await handle(awaitFix(makeSession({ userId: "ghost" }), "token-3"));

    expect(fake.calls).toEqual([
      { method: "failTask", input: expect.objectContaining({ taskToken: "token-3" }) as unknown },
    ]);
  });
});

it("acks messages for unknown sessions", async () => {
  await expect(
    handle(user({ type: "ACKNOWLEDGE" }, makeSession({ userId: "ghost" }))),
  ).resolves.toBeUndefined();
});
