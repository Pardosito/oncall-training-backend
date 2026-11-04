import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeInjector } from "../../src/dev/fake-injector.js";
import { createActionsService, QueueMessageSchema } from "../../src/modules/actions/index.js";
import { createInMemoryHealthStreakStore } from "../../src/modules/dashboard/index.js";
import { createFakeMockCluster } from "../../src/modules/mock-cluster/index.js";
import {
  createDirectOrchestration,
  FaultMessageSchema,
} from "../../src/modules/orchestration/index.js";
import { createStaticScenariosRepo } from "../../src/modules/scenarios/index.js";
import {
  createDynamoSessionsRepo,
  createSessionsService,
  type Session,
} from "../../src/modules/sessions/index.js";
import { systemClock } from "../../src/platform/clock.js";
import { createLogger } from "../../src/platform/logger.js";
import { createSqsQueue } from "../../src/platform/queue.js";
import { ordersDownScenario } from "../../src/test-support/scenarios.js";
import { runConsumer } from "../../src/worker/consumer.js";
import { createMessageHandler } from "../../src/worker/handlers.js";
import { createMonitor, runMonitor } from "../../src/worker/monitor.js";
import {
  available,
  createTempQueues,
  createTempSessionsTable,
  deleteQueues,
  deleteTable,
  destroyAwsClients,
  localClients,
} from "../helpers/localstack.js";

async function until<T>(
  read: () => Promise<T>,
  ok: (v: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** BE-094-style: the real SQS consumer and monitor loops against LocalStack, fake cluster. */
describe.skipIf(!available)("MVP loop on LocalStack (direct orchestration)", () => {
  const aws = localClients();
  const root = new AbortController();
  let table = "";
  let urls = { faultsUrl: "", actionsUrl: "" };
  const loops: Promise<void>[] = [];

  beforeAll(async () => {
    [table, urls] = await Promise.all([createTempSessionsTable(aws), createTempQueues(aws)]);
  });
  afterAll(async () => {
    root.abort();
    await Promise.allSettled(loops);
    await Promise.all([
      deleteTable(aws, table),
      deleteQueues(aws, [urls.faultsUrl, urls.actionsUrl]),
    ]);
    destroyAwsClients(aws);
  });

  it("start → fault → fix → RESOLVED → reset", async () => {
    const scenario = { ...ordersDownScenario(), warmupSeconds: 1 };
    const logger = createLogger({ level: "silent" });
    const clock = systemClock;
    const sessions = createDynamoSessionsRepo({ ddb: aws.ddbDoc, table });
    const scenarios = createStaticScenariosRepo([scenario]);
    const queue = createSqsQueue(aws.sqs, 1);
    const cluster = createFakeMockCluster({ baseline: scenario.baseline });
    const streaks = createInMemoryHealthStreakStore();
    const orchestration = createDirectOrchestration({
      sessions,
      queue,
      logger,
      faultsQueueUrl: urls.faultsUrl,
      userActionsQueueUrl: urls.actionsUrl,
    });
    const shared = { sessions, scenarios, clock, logger };
    const worker = { ...shared, cluster, orchestration, streaks };
    loops.push(
      runConsumer({
        queue,
        queueUrl: urls.actionsUrl,
        parse: (b) => QueueMessageSchema.parse(b),
        handle: createMessageHandler(worker),
        logger,
        signal: root.signal,
      }),
      runConsumer({
        queue,
        queueUrl: urls.faultsUrl,
        parse: (b) => FaultMessageSchema.parse(b),
        handle: createFakeInjector({ sessions, cluster, clock, logger }),
        logger,
        signal: root.signal,
      }),
      runMonitor({ monitor: createMonitor(worker), logger, signal: root.signal, intervalMs: 300 }),
    );
    const sessionsService = createSessionsService({ ...shared, orchestration, namespace: "mock" });
    const actions = createActionsService({
      ...shared,
      queue,
      userActionsQueueUrl: urls.actionsUrl,
      cluster,
    });
    const user = { userId: "it-user", username: "it" };

    const { sessionId } = await sessionsService.startSession(user, scenario.id);
    const key = { userId: user.userId, sessionId };
    const get = () => sessions.get(key) as Promise<Session>;

    await until(get, (s) => s.state === "INCIDENT_ACTIVE");
    expect(
      (await cluster.listDeployments()).find((d) => d.name === "orders")?.desiredReplicas,
    ).toBe(0);

    await actions.submit(user, sessionId, { type: "ACKNOWLEDGE" });
    await actions.submit(user, sessionId, {
      type: "SCALE_DEPLOYMENT",
      target: "orders",
      params: { replicas: 1 },
    });

    const resolved = await until(get, (s) => s.state === "RESOLVED");
    expect(resolved).toMatchObject({ actionsCount: 2, wrongActions: 0 });
    expect(resolved.score).toBeGreaterThan(900);
    expect(resolved.acknowledgedAt).toBeDefined();

    // SESSION_ENDED resets orders to its baseline of 2.
    await until(
      async () =>
        (await cluster.listDeployments()).find((d) => d.name === "orders")?.desiredReplicas,
      (replicas) => replicas === 2,
    );
  }, 40_000);
});
