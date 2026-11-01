import { createApp } from "./app.js";
import { openApiRouter } from "./openapi/openapi.routes.js";
import { createAwsClients, createAwsReadinessChecks, destroyAwsClients } from "./platform/aws.js";
import { bootstrap, closeServer, onShutdownSignal } from "./platform/process.js";

/** In-flight requests get this long to finish after SIGTERM (k8s grace period is 30 s). */
const SHUTDOWN_TIMEOUT_MS = 10_000;

const { config, logger } = bootstrap("api");
const aws = createAwsClients(config);

const app = createApp({
  logger,
  readinessChecks: createAwsReadinessChecks(aws, config),
  publicRouters: [openApiRouter()],
});

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
});
