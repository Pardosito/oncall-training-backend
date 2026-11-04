import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFixedClock } from "../platform/clock.js";
import { createLogger } from "../platform/logger.js";
import { ordersDownScenario } from "../test-support/scenarios.js";
import { makeSession, T0 } from "../test-support/sessions.js";
import { createInMemoryHealthStreakStore } from "../modules/dashboard/index.js";
import { createFakeMockCluster, type MockClusterGateway } from "../modules/mock-cluster/index.js";
import { createFakeOrchestration } from "../modules/orchestration/index.js";
import { createStaticScenariosRepo } from "../modules/scenarios/index.js";
import { createInMemorySessionsRepo, STARTING_GRACE_SECONDS } from "../modules/sessions/index.js";
import { createMonitor, runMonitor } from "./monitor.js";

const scenario = ordersDownScenario();
const logger = createLogger({ level: "silent" });
const at = (s: number) => new Date(T0.getTime() + s * 1000).toISOString();

let sessions: ReturnType<typeof createInMemorySessionsRepo>;
let cluster: ReturnType<typeof createFakeMockCluster>;
let fake: ReturnType<typeof createFakeOrchestration>;
let clock: ReturnType<typeof createFixedClock>;

function monitor(gateway: MockClusterGateway = cluster) {
  return createMonitor({
    sessions,
    scenarios: createStaticScenariosRepo([scenario]),
    cluster: gateway,
    orchestration: fake.orchestration,
    streaks: createInMemoryHealthStreakStore(),
    clock,
    logger,
  });
}

beforeEach(() => {
  sessions = createInMemorySessionsRepo();
  cluster = createFakeMockCluster({ baseline: scenario.baseline });
  fake = createFakeOrchestration();
  clock = createFixedClock(T0);
});

describe("monitor tick", () => {
  it("does nothing (and no k8s calls) without an active session", async () => {
    const listDeployments = vi.fn(() => cluster.listDeployments());
    expect(await monitor({ ...cluster, listDeployments }).tick()).toBe("idle");
    expect(listDeployments).not.toHaveBeenCalled();
  });

  it("waits while STARTING", async () => {
    await sessions.create(makeSession());
    clock.advance(10);
    expect(await monitor().tick()).toBe("waiting");
  });

  it("resets the mock system to baseline once while STARTING", async () => {
    cluster.applyFault({ type: "SCALE_TO_ZERO", target: "orders" }); // left over from a race
    await sessions.create(makeSession());
    const scale = vi.spyOn(cluster, "scale");
    const m = monitor();

    expect(await m.tick()).toBe("waiting");
    expect(await m.tick()).toBe("waiting");

    expect(scale).toHaveBeenCalledTimes(Object.keys(scenario.baseline).length);
    const orders = (await cluster.listDeployments()).find((d) => d.name === "orders");
    expect(orders?.desiredReplicas).toBe(scenario.baseline.orders);
  });

  it("skips the pre-fault reset when the fault is less than 5 s away", async () => {
    await sessions.create(makeSession());
    clock.advance(scenario.warmupSeconds - 4);
    const scale = vi.spyOn(cluster, "scale");

    expect(await monitor().tick()).toBe("waiting");

    expect(scale).not.toHaveBeenCalled();
  });

  it("fails a session stuck in STARTING with ERROR", async () => {
    await sessions.create(makeSession());
    clock.advance(scenario.warmupSeconds + STARTING_GRACE_SECONDS);

    expect(await monitor().tick()).toBe("timed-out");
    expect(fake.calls).toMatchObject([
      { method: "failTask", input: { from: "STARTING", reason: "ERROR" } },
    ]);
  });

  it("fails an incident past maxResolveSeconds with TIMEOUT", async () => {
    await sessions.create(makeSession({ state: "INCIDENT_ACTIVE", faultInjectedAt: at(20) }));
    clock.advance(20 + scenario.maxResolveSeconds);

    expect(await monitor().tick()).toBe("timed-out");
    expect(fake.calls).toMatchObject([{ method: "failTask", input: { reason: "TIMEOUT" } }]);
  });

  it("does not resolve a healthy system without a valid fix", async () => {
    await sessions.create(makeSession({ state: "INCIDENT_ACTIVE", faultInjectedAt: at(20) }));
    const m = monitor();
    clock.advance(30);
    expect(await m.tick()).toBe("watching");
    expect(await m.tick()).toBe("watching");
    expect(fake.calls).toEqual([]);
  });

  it("resolves after 2 consecutive healthy checks once a fix was applied", async () => {
    const session = makeSession({
      state: "INCIDENT_ACTIVE",
      faultInjectedAt: at(20),
      acknowledgedAt: at(30),
      validFixAppliedAt: at(60),
      wrongActions: 1,
      actionsCount: 3,
    });
    await sessions.create(session);
    cluster.applyFault({ type: "SCALE_TO_ZERO", target: "orders" });
    const m = monitor();
    clock.advance(62);

    expect(await m.tick()).toBe("watching"); // still down
    await cluster.scale("orders", 1);
    expect(await m.tick()).toBe("watching"); // healthy ×1
    clock.advance(2);
    expect(await m.tick()).toBe("resolved"); // healthy ×2

    // TTD 10 s, TTR 44 s → 1000 − 10 − 44 − 25 = 921
    expect(fake.calls).toEqual([
      {
        method: "completeTask",
        input: {
          key: { userId: session.userId, sessionId: session.sessionId },
          output: {
            resolvedAt: at(64),
            ttdSeconds: 10,
            ttrSeconds: 44,
            wrongActions: 1,
            actionsCount: 3,
            score: 921,
          },
        },
      },
    ]);
  });

  it("resets the streak when a service goes down again", async () => {
    await sessions.create(
      makeSession({ state: "INCIDENT_ACTIVE", faultInjectedAt: at(20), validFixAppliedAt: at(40) }),
    );
    const m = monitor();
    clock.advance(41);
    expect(await m.tick()).toBe("watching");
    cluster.applyFault({ type: "SCALE_TO_ZERO", target: "worker-svc" });
    expect(await m.tick()).toBe("watching");
    await cluster.scale("worker-svc", 1);
    expect(await m.tick()).toBe("watching");
    expect(await m.tick()).toBe("resolved");
  });
});

describe("runMonitor", () => {
  it("keeps ticking after a failed tick and stops on abort", async () => {
    const controller = new AbortController();
    let ticks = 0;
    const tick = vi.fn(() => {
      if (++ticks === 3) controller.abort();
      return ticks === 1 ? Promise.reject(new Error("ddb down")) : Promise.resolve("idle" as const);
    });

    await runMonitor({ monitor: { tick }, logger, signal: controller.signal, intervalMs: 1 });

    expect(tick).toHaveBeenCalledTimes(3);
  });
});
