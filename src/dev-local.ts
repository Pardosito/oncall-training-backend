import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeInjector } from "./dev/fake-injector.js";
import { createFakeMockCluster } from "./modules/mock-cluster/index.js";
import { FaultMessageSchema } from "./modules/orchestration/index.js";
import {
  createStaticScenariosRepo,
  parseScenarioFiles,
  type ScenariosRepo,
} from "./modules/scenarios/index.js";
import { createInMemorySessionsRepo } from "./modules/sessions/index.js";
import { createAwsClients, createAwsReadinessChecks } from "./platform/aws.js";
import { systemClock } from "./platform/clock.js";
import type { ReadinessCheck } from "./platform/http/health.js";
import { bootstrap, closeServer, onShutdownSignal } from "./platform/process.js";
import { createInMemoryQueue } from "./platform/queue.js";
import {
  buildApiApp,
  createAwsBackedServices,
  type Services,
  startWorkerLoops,
} from "./runtime.js";
import { runConsumer } from "./worker/consumer.js";

/**
 * `pnpm dev:local` (D-29): api + worker + a fake injector in ONE process around one shared fake
 * cluster, so the whole MVP loop runs on a laptop with `MOCK_CLUSTER=fake`.
 *   pnpm dev:local              DynamoDB, S3 and SQS in LocalStack (`docker compose up -d`)
 *   pnpm dev:local --in-memory  no Docker at all: everything in memory, scenarios from ./scenarios
 * Never used in AWS: the image runs `api.js` / `worker.js`.
 */
const inMemory = process.argv.includes("--in-memory");

if (inMemory) {
  // Placeholders so the config schema passes; nothing talks to AWS in this mode.
  process.env.SESSIONS_TABLE ??= "Sessions";
  process.env.FILES_BUCKET ??= "in-memory";
  process.env.USER_ACTIONS_QUEUE_URL ??= "http://in-memory/000000000000/user-actions.fifo";
  process.env.FAULTS_QUEUE_URL ??= "http://in-memory/000000000000/faults";
}
process.env.NODE_ENV ??= "development";
process.env.AUTH_MODE ??= "dev";
process.env.ORCHESTRATION_MODE = "direct";
process.env.MOCK_CLUSTER = "fake";

const { config, logger } = bootstrap("api");
const clock = systemClock;

function scenariosFromDisk(): ScenariosRepo {
  const dir = join(import.meta.dirname, "..", "scenarios");
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ key: name, body: readFileSync(join(dir, name), "utf8") }));
  return createStaticScenariosRepo(parseScenarioFiles(files, logger));
}

let backed: Pick<Services, "sessions" | "scenarios" | "queue">;
let readinessChecks: ReadinessCheck[] = [];
if (inMemory) {
  backed = {
    sessions: createInMemorySessionsRepo(),
    scenarios: scenariosFromDisk(),
    queue: createInMemoryQueue({ pollMs: 1_000 }),
  };
} else {
  const aws = createAwsClients(config);
  backed = createAwsBackedServices(config, logger, aws);
  readinessChecks = createAwsReadinessChecks(aws, config);
}

const baseline = Object.assign(
  {},
  ...(await backed.scenarios.list()).map((s) => s.baseline),
) as Record<string, number>;
const cluster = createFakeMockCluster({ baseline, clock });
const services: Services = { config, logger, clock, ...backed, cluster };

const root = new AbortController();
const loops = [
  ...startWorkerLoops(services, root.signal),
  runConsumer({
    queue: backed.queue,
    queueUrl: config.FAULTS_QUEUE_URL ?? "",
    parse: (body) => FaultMessageSchema.parse(body),
    handle: createFakeInjector({ sessions: backed.sessions, cluster, clock, logger }),
    name: "fake-injector",
    logger,
    signal: root.signal,
  }),
];

const server = buildApiApp(services, readinessChecks).listen(config.PORT, () => {
  logger.info(
    { port: config.PORT, inMemory, scenarios: Object.keys(baseline).length > 0 },
    "dev:local ready: api + worker + fake injector (send x-dev-user: <id>[:<name>])",
  );
});

onShutdownSignal(logger, async () => {
  root.abort();
  await Promise.allSettled(loops);
  await closeServer(server, 2_000);
});
