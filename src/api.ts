import { createAwsClients, createAwsReadinessChecks, destroyAwsClients } from "./platform/aws.js";
import { systemClock } from "./platform/clock.js";
import { bootstrap, closeServer, onShutdownSignal } from "./platform/process.js";
import { closeRedis } from "./platform/redis.js";
import {
  buildApiApp,
  createAwsBackedServices,
  createMockCluster,
  createRedisServices,
} from "./runtime.js";

/** In-flight requests get this long to finish after SIGTERM (k8s grace period is 30 s). */
const SHUTDOWN_TIMEOUT_MS = 10_000;

const { config, logger } = bootstrap("api");
const aws = createAwsClients(config);
const backed = createAwsBackedServices(config, logger, aws);
const { redis, lock, events, readinessChecks: redisChecks } = createRedisServices(config, logger);
const services = {
  config,
  logger,
  clock: systemClock,
  ...backed,
  cluster: await createMockCluster(config, backed.scenarios),
  ...(lock ? { lock } : {}),
  ...(events ? { events } : {}),
};

const app = buildApiApp(services, [...createAwsReadinessChecks(aws, config), ...redisChecks]);

const server = app.listen(config.PORT, () => {
  logger.info(
    {
      port: config.PORT,
      authMode: config.AUTH_MODE,
      orchestrationMode: config.ORCHESTRATION_MODE,
      mockCluster: config.MOCK_CLUSTER,
      redis: Boolean(config.REDIS_URL),
    },
    "api listening",
  );
});

onShutdownSignal(logger, async () => {
  await closeServer(server, SHUTDOWN_TIMEOUT_MS);
  destroyAwsClients(aws);
  if (redis) await closeRedis(redis);
});
