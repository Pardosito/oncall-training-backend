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
  dashboardRouter,
} from "./modules/dashboard/index.js";
import {
  createFakeMockCluster,
  createHttpHealthChecker,
  createKubernetesMockCluster,
  type MockClusterGateway,
} from "./modules/mock-cluster/index.js";
import { createDirectOrchestration, type Orchestration } from "./modules/orchestration/index.js";
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
import { openApiRouter } from "./openapi/openapi.routes.js";
import type { AwsClients } from "./platform/aws.js";
import { type Clock, systemClock } from "./platform/clock.js";
import type { ReadinessCheck } from "./platform/http/health.js";
import type { Logger } from "./platform/logger.js";
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
};

/** Repos and the queue on real AWS clients (LocalStack locally, through `AWS_ENDPOINT_URL`). */
export function createAwsBackedServices(config: Config, logger: Logger, aws: AwsClients) {
  return {
    sessions: createDynamoSessionsRepo({ ddb: aws.ddbDoc, table: config.SESSIONS_TABLE }),
    scenarios: createS3ScenariosRepo({ s3: aws.s3, bucket: config.FILES_BUCKET, logger }),
    queue: createSqsQueue(aws.sqs),
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

/** Direct orchestration in the Nov 5 MVP (D-24); Step Functions arrives in M2 (BE-062). */
export function createOrchestration(services: Services): Orchestration {
  const { config } = services;
  if (config.ORCHESTRATION_MODE !== "direct") {
    throw new Error(
      "ORCHESTRATION_MODE=stepfunctions is not implemented yet (M2, BE-062); set ORCHESTRATION_MODE=direct",
    );
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
  const auth =
    config.AUTH_MODE === "dev"
      ? createAuthMiddleware({ mode: "dev", logger })
      : createAuthMiddleware({ mode: "cognito", logger, verifier: createCognitoVerifier(config) });

  return createApp({
    logger,
    readinessChecks,
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
        }),
      }),
      dashboardRouter({
        service: createDashboardService({ sessions, scenarios, cluster, clock, logger }),
      }),
    ],
  });
}

/** Starts the worker's loops (consumer + monitor); they stop when `signal` aborts. */
export function startWorkerLoops(services: Services, signal: AbortSignal): Promise<void>[] {
  const { config, logger, clock, sessions, scenarios, queue, cluster } = services;
  const orchestration = createOrchestration(services);
  // One worker replica (D-08), so the streak can live in memory until Redis (D-26).
  const streaks = createInMemoryHealthStreakStore();
  const shared = { sessions, scenarios, cluster, orchestration, streaks, clock, logger };

  return [
    runConsumer({
      queue,
      queueUrl: config.USER_ACTIONS_QUEUE_URL,
      parse: (body) => QueueMessageSchema.parse(body),
      handle: createMessageHandler(shared),
      logger,
      signal,
    }),
    runMonitor({ monitor: createMonitor(shared), logger, signal }),
  ];
}
