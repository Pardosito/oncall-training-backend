import type { S3Client } from "@aws-sdk/client-s3";
import type { SFNClient } from "@aws-sdk/client-sfn";
import type { Redis } from "ioredis";
import type { Express } from "express";
import { createApp } from "./app.js";
import type { Config } from "./config/index.js";
import {
  actionsRouter,
  createActionsService,
  QueueMessageSchema,
} from "./modules/actions/index.js";
import { createAuthMiddleware, createCognitoVerifier } from "./modules/auth/index.js";
import {
  createDashboardService,
  createInMemoryHealthStreakStore,
  createRedisHealthStreakStore,
  createRedisSnapshotStore,
  dashboardRouter,
  type HealthStreakStore,
  type SnapshotStore,
} from "./modules/dashboard/index.js";
import {
  createEventFlusher,
  createEventRecorder,
  createRedisEventLog,
  type EventLog,
} from "./modules/events/index.js";
import {
  createFakeMockCluster,
  createHttpHealthChecker,
  createKubernetesMockCluster,
  type MockClusterGateway,
} from "./modules/mock-cluster/index.js";
import {
  createDirectOrchestration,
  createStepFunctionsOrchestration,
  type Orchestration,
} from "./modules/orchestration/index.js";
import {
  createS3ScenariosRepo,
  type ScenariosRepo,
  scenariosRouter,
} from "./modules/scenarios/index.js";
import {
  createDynamoSessionsRepo,
  createSessionsService,
  type SessionsRepo,
  sessionsRouter,
} from "./modules/sessions/index.js";
import { createLeaderboardService, leaderboardRouter } from "./modules/leaderboard/index.js";
import { createStatsService, statsRouter } from "./modules/stats/index.js";
import { openApiRouter } from "./openapi/openapi.routes.js";
import type { AwsClients } from "./platform/aws.js";
import { type Clock, systemClock } from "./platform/clock.js";
import type { ReadinessCheck } from "./platform/http/health.js";
import { createRedisLock, type Lock } from "./platform/lock.js";
import type { Logger } from "./platform/logger.js";
import { createRedis, createRedisReadinessCheck } from "./platform/redis.js";
import { createSqsQueue, type MessageQueue } from "./platform/queue.js";
import { createMessageHandler } from "./worker/handlers.js";
import { createMonitor, runMonitor } from "./worker/monitor.js";
import { runConsumer } from "./worker/consumer.js";

/**
 * Composition root shared by `api.ts`, `worker.ts` and `dev-local.ts` (CONVENTIONS §3): the only
 * place real implementations are picked from config and wired together.
 */
export type Services = {
  config: Config;
  logger: Logger;
  clock: Clock;
  sessions: SessionsRepo;
  scenarios: ScenariosRepo;
  queue: MessageQueue;
  cluster: MockClusterGateway;
  /** Only needed with `ORCHESTRATION_MODE=stepfunctions`. */
  sfn?: Pick<SFNClient, "send">;
  /** The global lock (D-05), only when `REDIS_URL` is set; without it the MVP busy check runs. */
  lock?: Lock;
  /** The session event log (D-20), only when `REDIS_URL` is set. */
  events?: EventLog;
  /** The resolution streak in Redis (BE-099); in worker memory without it (D-26). */
  streaks?: HealthStreakStore;
  /** Dashboard snapshots in Redis (BE-097); built on each request without it (BE-130). */
  snapshots?: SnapshotStore;
  /** For the event flush (`FILES_BUCKET`); absent in `dev:local --in-memory`. */
  s3?: Pick<S3Client, "send">;
};

/**
 * Redis when `REDIS_URL` is set (BE-023): the client (closed on shutdown), the global lock, the
 * event log and the `/readyz` check. Nothing without it (Nov 5 MVP, D-24).
 */
export function createRedisServices(
  config: Pick<Config, "REDIS_URL">,
  logger: Logger,
): {
  redis?: Redis;
  lock?: Lock;
  events?: EventLog;
  streaks?: HealthStreakStore;
  snapshots?: SnapshotStore;
  readinessChecks: ReadinessCheck[];
} {
  if (!config.REDIS_URL) return { readinessChecks: [] };
  const redis = createRedis(config.REDIS_URL, logger);
  return {
    redis,
    lock: createRedisLock({ redis }),
    events: createRedisEventLog({ redis, logger }),
    streaks: createRedisHealthStreakStore({ redis }),
    snapshots: createRedisSnapshotStore({ redis, logger }),
    readinessChecks: [createRedisReadinessCheck(redis)],
  };
}

/** Repos and the queue on real AWS clients (LocalStack locally, through `AWS_ENDPOINT_URL`). */
export function createAwsBackedServices(config: Config, logger: Logger, aws: AwsClients) {
  return {
    sessions: createDynamoSessionsRepo({ ddb: aws.ddbDoc, table: config.SESSIONS_TABLE }),
    scenarios: createS3ScenariosRepo({ s3: aws.s3, bucket: config.FILES_BUCKET, logger }),
    queue: createSqsQueue(aws.sqs),
    sfn: aws.sfn,
    s3: aws.s3,
  };
}

/**
 * BE-080: `kubernetes` reads the mock namespace with the pod's ServiceAccount; `fake` is an
 * in-memory cluster at the scenarios' baseline. A fake cluster lives in one process, so the
 * api and the worker only share it inside `pnpm dev:local`.
 */
export async function createMockCluster(
  config: Config,
  scenarios: ScenariosRepo,
  clock: Clock = systemClock,
): Promise<MockClusterGateway> {
  if (config.MOCK_CLUSTER === "kubernetes") {
    return createKubernetesMockCluster({
      namespace: config.MOCK_NAMESPACE,
      checkHealth: createHttpHealthChecker({ urlTemplate: config.MOCK_HEALTH_URL_TEMPLATE }),
    });
  }
  const baseline = Object.assign({}, ...(await scenarios.list()).map((s) => s.baseline)) as Record<
    string,
    number
  >;
  return createFakeMockCluster({ baseline, clock });
}

/** Step Functions (M2, BE-062/063) or the direct orchestration of the Nov 5 MVP (D-24). */
export function createOrchestration(services: Services): Orchestration {
  const { config } = services;
  if (config.ORCHESTRATION_MODE === "stepfunctions") {
    // loadConfig already requires STATE_MACHINE_ARN in this mode.
    if (!services.sfn || !config.STATE_MACHINE_ARN) {
      throw new Error("ORCHESTRATION_MODE=stepfunctions needs an SFN client and STATE_MACHINE_ARN");
    }
    return createStepFunctionsOrchestration({
      sfn: services.sfn,
      stateMachineArn: config.STATE_MACHINE_ARN,
      sessions: services.sessions,
      logger: services.logger,
    });
  }
  return createDirectOrchestration({
    sessions: services.sessions,
    queue: services.queue,
    logger: services.logger,
    userActionsQueueUrl: config.USER_ACTIONS_QUEUE_URL,
    faultsQueueUrl: config.FAULTS_QUEUE_URL,
  });
}

export function buildApiApp(services: Services, readinessChecks: ReadinessCheck[]): Express {
  const { config, logger, clock, sessions, scenarios, queue, cluster } = services;
  const orchestration = createOrchestration(services);
  const recorder = services.events
    ? { events: createEventRecorder({ events: services.events, logger }) }
    : {};
  const auth =
    config.AUTH_MODE === "dev"
      ? createAuthMiddleware({ mode: "dev", logger })
      : createAuthMiddleware({ mode: "cognito", logger, verifier: createCognitoVerifier(config) });

  return createApp({
    logger,
    readinessChecks,
    corsOrigins: config.CORS_ORIGINS,
    auth,
    publicRouters: [openApiRouter()],
    routers: [
      scenariosRouter({ scenarios }),
      sessionsRouter({
        service: createSessionsService({
          sessions,
          scenarios,
          orchestration,
          clock,
          logger,
          namespace: config.MOCK_NAMESPACE,
          ...(services.lock ? { lock: services.lock } : {}),
          ...recorder,
        }),
      }),
      actionsRouter({
        service: createActionsService({
          sessions,
          scenarios,
          queue,
          userActionsQueueUrl: config.USER_ACTIONS_QUEUE_URL,
          cluster,
          clock,
          ...recorder,
        }),
      }),
      statsRouter({ service: createStatsService({ sessions }) }),
      leaderboardRouter({ service: createLeaderboardService({ sessions, scenarios }) }),
      dashboardRouter({
        service: createDashboardService({
          sessions,
          scenarios,
          cluster,
          clock,
          logger,
          ...(services.events ? { events: services.events } : {}),
          ...(services.snapshots ? { snapshots: services.snapshots } : {}),
        }),
      }),
    ],
  });
}

/** Starts the worker's loops (consumer + monitor); they stop when `signal` aborts. */
export function startWorkerLoops(services: Services, signal: AbortSignal): Promise<void>[] {
  const { config, logger, clock, sessions, scenarios, queue, cluster } = services;
  const orchestration = createOrchestration(services);
  // Without Redis: one worker replica (D-08), so the streak can live in memory (D-26).
  const streaks = services.streaks ?? createInMemoryHealthStreakStore();
  const shared = {
    sessions,
    scenarios,
    cluster,
    orchestration,
    streaks,
    clock,
    logger,
    ...(services.lock ? { lock: services.lock } : {}),
  };
  const recorder = services.events
    ? createEventRecorder({ events: services.events, logger })
    : undefined;
  // Without S3 (in-memory dev) there's nowhere to flush, so no event log at all.
  const events =
    services.events && recorder && services.s3
      ? {
          recorder,
          log: services.events,
          flusher: createEventFlusher({
            events: services.events,
            s3: services.s3,
            bucket: config.FILES_BUCKET,
            logger,
          }),
        }
      : undefined;

  return [
    runConsumer({
      queue,
      queueUrl: config.USER_ACTIONS_QUEUE_URL,
      parse: (body) => QueueMessageSchema.parse(body),
      handle: createMessageHandler({
        ...shared,
        ...(events ? { events } : {}),
        ...(services.snapshots ? { snapshots: services.snapshots } : {}),
      }),
      logger,
      signal,
    }),
    runMonitor({
      monitor: createMonitor({
        ...shared,
        ...(events ? { events: events.recorder, eventLog: events.log } : {}),
        ...(services.snapshots ? { snapshots: services.snapshots } : {}),
        enforceTimeouts: config.ORCHESTRATION_MODE === "direct",
      }),
      logger,
      signal,
    }),
  ];
}
