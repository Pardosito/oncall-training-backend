import { createAwsClients, destroyAwsClients } from "./platform/aws.js";
import {
  bootstrap,
  closeServer,
  createHealthServer,
  onShutdownSignal,
} from "./platform/process.js";

const { config, logger } = bootstrap("worker");
const aws = createAwsClients(config);

/** Aborted on SIGTERM; every loop (consumer, monitor) stops on it (CONVENTIONS §10). */
const root = new AbortController();
const loops: Promise<void>[] = [];

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
  await Promise.allSettled(loops);
  await closeServer(healthServer, 1_000);
  destroyAwsClients(aws);
});
