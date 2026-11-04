import { describe, expect, it } from "vitest";
import { createFixedClock } from "../platform/clock.js";
import { createLogger } from "../platform/logger.js";
import { createInMemoryQueue, type MessageQueue } from "../platform/queue.js";
import { ordersDownScenario } from "../test-support/scenarios.js";
import { T0 } from "../test-support/sessions.js";
import { createFakeInjector } from "../dev/fake-injector.js";
import { createActionsService, QueueMessageSchema } from "../modules/actions/index.js";
import { createInMemoryHealthStreakStore } from "../modules/dashboard/index.js";
import { createFakeMockCluster } from "../modules/mock-cluster/index.js";
import { createDirectOrchestration, FaultMessageSchema } from "../modules/orchestration/index.js";
import { createStaticScenariosRepo } from "../modules/scenarios/index.js";
import { createInMemorySessionsRepo, createSessionsService } from "../modules/sessions/index.js";
import { createMessageHandler } from "./handlers.js";
import { createMonitor } from "./monitor.js";

const FAULTS = "faults";
const ACTIONS = "user-actions.fifo";

/** Receives everything visible on `url` and passes each parsed body to `handle`, then deletes it. */
async function deliver<T>(
  queue: MessageQueue,
  url: string,
  parse: (b: unknown) => T,
  handle: (m: T) => Promise<void>,
) {
  for (const m of await queue.receive(url)) {
    await handle(parse(JSON.parse(m.body)));
    await queue.delete(url, m.receiptHandle);
  }
}

describe("MVP incident loop (in memory, D-24)", () => {
  it("start → fault → acknowledge → fix → resolved → reset", async () => {
    const scenario = ordersDownScenario();
    const logger = createLogger({ level: "silent" });
    const clock = createFixedClock(T0);
    const queue = createInMemoryQueue({ now: () => clock.now().getTime() });
    const sessions = createInMemorySessionsRepo();
    const scenarios = createStaticScenariosRepo([scenario]);
    const cluster = createFakeMockCluster({ baseline: scenario.baseline, clock });
    const streaks = createInMemoryHealthStreakStore();
    const orchestration = createDirectOrchestration({
      sessions,
      queue,
      logger,
      faultsQueueUrl: FAULTS,
      userActionsQueueUrl: ACTIONS,
    });
    const shared = { sessions, scenarios, clock, logger };
    const sessionsService = createSessionsService({ ...shared, orchestration, namespace: "mock" });
    const actions = createActionsService({
      ...shared,
      queue,
      userActionsQueueUrl: ACTIONS,
      cluster,
    });
    const handle = createMessageHandler({ ...shared, cluster, orchestration, streaks });
    const inject = createFakeInjector({ sessions, cluster, clock, logger });
    const monitor = createMonitor({ ...shared, cluster, orchestration, streaks });
    const user = { userId: "user-a", username: "alice" };
    const parseAction = (b: unknown) => QueueMessageSchema.parse(b);

    // 1. Start: STARTING, FAULT delayed by the warmup.
    const { sessionId } = await sessionsService.startSession(user, "orders-down");
    const key = { userId: user.userId, sessionId };
    await deliver(queue, FAULTS, (b) => FaultMessageSchema.parse(b), inject);
    expect((await sessions.get(key))?.state).toBe("STARTING");
    expect(await monitor.tick()).toBe("waiting");

    // 2. Warmup over: the injector breaks orders.
    clock.advance(scenario.warmupSeconds);
    await deliver(queue, FAULTS, (b) => FaultMessageSchema.parse(b), inject);
    expect((await sessions.get(key))?.state).toBe("INCIDENT_ACTIVE");
    expect(await monitor.tick()).toBe("watching");

    // 3. The user acknowledges at +15 s, makes one wrong move, then the right fix at +40 s.
    clock.advance(15);
    await actions.submit(user, sessionId, { type: "ACKNOWLEDGE" });
    clock.advance(10);
    await actions.submit(user, sessionId, { type: "RESTART_DEPLOYMENT", target: "gateway" });
    clock.advance(15);
    await actions.submit(user, sessionId, {
      type: "SCALE_DEPLOYMENT",
      target: "orders",
      params: { replicas: 1 },
    });
    await deliver(queue, ACTIONS, parseAction, handle);

    // 4. Two healthy checks → RESOLVED with the score.
    clock.advance(2);
    expect(await monitor.tick()).toBe("watching");
    clock.advance(2);
    expect(await monitor.tick()).toBe("resolved");
    const resolved = await sessions.get(key);
    // TTD 15 s, TTR 44 s, 1 wrong → 1000 − 15 − 44 − 25 = 916
    expect(resolved).toMatchObject({
      state: "RESOLVED",
      ttdSeconds: 15,
      ttrSeconds: 44,
      wrongActions: 1,
      actionsCount: 3,
      score: 916,
    });

    // 5. SESSION_ENDED resets the mock system; the next session can start.
    expect(await monitor.tick()).toBe("idle");
    await deliver(queue, ACTIONS, parseAction, handle);
    const replicas = Object.fromEntries(
      (await cluster.listDeployments()).map((d) => [d.name, d.desiredReplicas]),
    );
    expect(replicas).toEqual(scenario.baseline);
    await expect(sessionsService.startSession(user, "orders-down")).resolves.toBeDefined();
  });
});
