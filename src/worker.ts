import { createAwsClients, destroyAwsClients } from "./platform/aws.js";
import { systemClock } from "./platform/clock.js";
import {
  bootstrap,
  closeServer,
  createHealthServer,
  onShutdownSignal,
} from "./platform/process.js";
import { createAwsBackedServices, createMockCluster, startWorkerLoops } from "./runtime.js";

/** In-flight messages get this long to finish after SIGTERM (CONVENTIONS §10). */
const DRAIN_TIMEOUT_MS = 25_000;

const { config, logger } = bootstrap("worker");
const aws = createAwsClients(config);
const backed = createAwsBackedServices(config, logger, aws);
const services = {
  config,
  logger,
  clock: systemClock,
  ...backed,
  cluster: await createMockCluster(config, backed.scenarios),
};

/** Aborted on SIGTERM; every loop (consumer, monitor) stops on it (CONVENTIONS §10). */
const root = new AbortController();
const loops = startWorkerLoops(services, root.signal);

const healthServer = createHealthServer(() => !root.signal.aborted);
healthServer.listen(config.WORKER_HEALTH_PORT, () => {
  logger.info(
    {
      port: config.WORKER_HEALTH_PORT,
      orchestrationMode: config.ORCHESTRATION_MODE,
      mockCluster: config.MOCK_CLUSTER,
      redis: Boolean(config.REDIS_URL),
    },
    "worker started",
  );
});

onShutdownSignal(logger, async () => {
  root.abort();
  const drained = Promise.allSettled(loops);
  const timeout = new Promise((resolve) => setTimeout(resolve, DRAIN_TIMEOUT_MS).unref());
  await Promise.race([drained, timeout]);
  await closeServer(healthServer, 1_000);
  destroyAwsClients(aws);
});
