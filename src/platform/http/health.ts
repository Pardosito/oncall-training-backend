import { Router } from "express";
import { AppError } from "../errors.js";
import type { Logger } from "../logger.js";
import { sendError } from "./error-handler.js";

export type ReadinessCheck = {
  name: string;
  /** Resolves when the dependency is reachable; must honor the abort signal. */
  check: (signal: AbortSignal) => Promise<void>;
};

export type CheckStatus = "ok" | "fail";
export type ReadinessResult = { ready: boolean; checks: Record<string, CheckStatus> };

export const READINESS_TIMEOUT_MS = 2000;

/** Runs every check in parallel, each with its own timeout. Never exposes the upstream error text. */
export async function runReadinessChecks(
  checks: ReadinessCheck[],
  logger: Logger,
  timeoutMs = READINESS_TIMEOUT_MS,
): Promise<ReadinessResult> {
  const results = await Promise.all(
    checks.map(async ({ name, check }): Promise<[string, CheckStatus]> => {
      try {
        await check(AbortSignal.timeout(timeoutMs));
        return [name, "ok"];
      } catch (error) {
        logger.warn({ err: error, check: name }, "readiness check failed");
        return [name, "fail"];
      }
    }),
  );
  const statuses = Object.fromEntries(results);
  return { ready: results.every(([, status]) => status === "ok"), checks: statuses };
}

/** `/healthz` (process alive, no dependencies) and `/readyz` (dependencies reachable). */
export function healthRouter(deps: { checks: ReadinessCheck[]; logger: Logger }): Router {
  const router = Router();

  router.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  router.get("/readyz", async (_req, res) => {
    const result = await runReadinessChecks(deps.checks, deps.logger);
    if (result.ready) {
      res.json({ status: "ready", checks: result.checks });
      return;
    }
    sendError(
      res,
      new AppError("NOT_READY", 503, "A dependency is unavailable.", { checks: result.checks }),
    );
  });

  return router;
}
