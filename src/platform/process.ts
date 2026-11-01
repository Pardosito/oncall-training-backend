import { createServer, type Server } from "node:http";
import {
  type Config,
  ConfigError,
  isDevAuthOutsideDevelopment,
  loadConfig,
  type ProcessKind,
} from "../config/index.js";
import { createLogger, type Logger } from "./logger.js";

/** Loads config or exits 1 with a readable list of every failing variable (CONVENTIONS §6). */
export function bootstrap(processKind: ProcessKind): { config: Config; logger: Logger } {
  let config: Config;
  try {
    config = loadConfig(process.env, processKind);
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
  const logger = createLogger({
    level: config.LOG_LEVEL,
    pretty: config.NODE_ENV === "development",
  }).child({ process: processKind });
  if (processKind === "api" && isDevAuthOutsideDevelopment(config)) {
    logger.warn("dev auth enabled outside development (MVP)");
  }
  return { config, logger };
}

/** Runs `shutdown` once on SIGTERM/SIGINT, then exits 0 (or 1 if shutdown throws). */
export function onShutdownSignal(logger: Logger, shutdown: () => Promise<void>): void {
  let shuttingDown = false;
  const handle = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    shutdown().then(
      () => {
        logger.info("shutdown complete");
        process.exit(0);
      },
      (error: unknown) => {
        logger.error({ err: error }, "shutdown failed");
        process.exit(1);
      },
    );
  };
  process.once("SIGTERM", handle);
  process.once("SIGINT", handle);
}

/** Stops accepting connections and waits for in-flight requests, up to `timeoutMs`. */
export function closeServer(server: Server, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      server.closeAllConnections();
      resolve();
    }, timeoutMs);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
    server.closeIdleConnections();
  });
}

/** The worker's `GET /healthz` on `WORKER_HEALTH_PORT`: 200 while `isHealthy()`, else 503. */
export function createHealthServer(isHealthy: () => boolean): Server {
  return createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      const healthy = isHealthy();
      res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: healthy ? "ok" : "stopping" }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "Route not found." } }));
  });
}
