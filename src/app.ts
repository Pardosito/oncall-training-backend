import express, { type Express, type RequestHandler, type Router } from "express";
import { pinoHttp } from "pino-http";
import type { Logger } from "./platform/logger.js";
import { corsAllowlist } from "./platform/http/cors.js";
import { errorHandler, notFoundHandler } from "./platform/http/error-handler.js";
import { healthRouter, type ReadinessCheck } from "./platform/http/health.js";
import { requestId } from "./platform/http/request-id.js";

export type AppDeps = {
  logger: Logger;
  readinessChecks: ReadinessCheck[];
  /** Auth middleware for everything under `/api` except the public routes mounted before it. */
  auth?: RequestHandler;
  /** Routers that need no auth (e.g. `GET /api/openapi.json`), mounted at `/api`. */
  publicRouters?: Router[];
  /** Feature routers, mounted at `/api` after auth. */
  routers?: Router[];
  /** Origins allowed cross-origin (D-35). Empty: no CORS headers, as with CloudFront (D-21). */
  corsOrigins?: readonly string[];
  /** Override for tests. */
  generateRequestId?: () => string;
};

/**
 * Builds the Express app with the middleware order from CONVENTIONS §4:
 * request id → pino-http → [cors] → json → health → auth → routers → 404 → error handler.
 * CORS only for the explicit `CORS_ORIGINS` allowlist (D-35); none when the SPA and API share an origin.
 */
export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  // CloudFront + ALB in AWS; Vite proxy + ALB in the Nov 5 MVP. Two hops either way.
  app.set("trust proxy", 2);

  app.use(requestId(deps.generateRequestId));
  app.use(
    pinoHttp({
      logger: deps.logger,
      genReqId: (_req, res) => (res as express.Response).locals.requestId,
      autoLogging: { ignore: (req) => req.url === "/healthz" || req.url === "/readyz" },
    }),
  );
  if (deps.corsOrigins?.length) app.use(corsAllowlist(deps.corsOrigins));
  app.use(express.json({ limit: "100kb" }));

  app.use(healthRouter({ checks: deps.readinessChecks, logger: deps.logger }));

  for (const router of deps.publicRouters ?? []) app.use("/api", router);
  if (deps.auth) app.use("/api", deps.auth);
  for (const router of deps.routers ?? []) app.use("/api", router);

  app.use(notFoundHandler());
  app.use(errorHandler(deps.logger));
  return app;
}
