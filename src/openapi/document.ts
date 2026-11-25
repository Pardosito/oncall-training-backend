import { OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registerActionsOpenApi } from "../modules/actions/index.js";
import { registerDashboardOpenApi } from "../modules/dashboard/index.js";
import { registerLeaderboardOpenApi } from "../modules/leaderboard/index.js";
import { registerScenariosOpenApi } from "../modules/scenarios/index.js";
import { registerSessionsOpenApi } from "../modules/sessions/index.js";
import { registerStatsOpenApi } from "../modules/stats/index.js";
import { createRegistry, ErrorBodySchema, jsonContent } from "./registry.js";

export const API_VERSION = "0.1.0";

/**
 * The frontend contract (D-04). Only routes that exist are registered.
 */
export function buildOpenApiDocument() {
  const registry = createRegistry();

  registry.registerPath({
    method: "get",
    path: "/healthz",
    tags: ["health"],
    summary: "Liveness: the process is up",
    responses: {
      200: { description: "Alive", ...jsonContent(z.object({ status: z.literal("ok") })) },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/readyz",
    tags: ["health"],
    summary: "Readiness: DynamoDB and S3 are reachable",
    responses: {
      200: {
        description: "Ready",
        ...jsonContent(
          z.object({
            status: z.literal("ready"),
            checks: z.record(z.string(), z.enum(["ok", "fail"])),
          }),
        ),
      },
      503: {
        description: "A dependency is unavailable (`NOT_READY`, `details.checks`)",
        ...jsonContent(ErrorBodySchema),
      },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/api/openapi.json",
    tags: ["health"],
    summary: "This document",
    responses: { 200: { description: "OpenAPI document" } },
  });

  registerScenariosOpenApi(registry);
  registerSessionsOpenApi(registry);
  registerActionsOpenApi(registry);
  registerDashboardOpenApi(registry);
  registerStatsOpenApi(registry);
  registerLeaderboardOpenApi(registry);

  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: {
      title: "On-Call Training API",
      version: API_VERSION,
      description:
        "Backend of On-Call Training. Generated from the zod schemas (`pnpm openapi`); do not edit by hand.",
    },
    servers: [{ url: "/" }],
  });
}

/** Recursively sorts object keys so the generated file diffs cleanly. */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function renderOpenApiJson(): string {
  return `${JSON.stringify(sortKeys(buildOpenApiDocument()), null, 2)}\n`;
}
