import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
  BEARER_AUTH,
  errorResponses,
  IsoDateTimeSchema,
  jsonContent,
  UlidSchema,
} from "../../openapi/registry.js";
import { EventTypeSchema } from "../events/index.js";
import { ActionTypeSchema } from "../scenarios/index.js";
import { SessionParamsSchema, SessionStateSchema } from "../sessions/index.js";

export const ServiceHealthSchema = z
  .enum(["healthy", "degraded", "down"])
  .meta({ id: "ServiceHealth" });
export type ServiceHealth = z.infer<typeof ServiceHealthSchema>;

export const PodViewSchema = z
  .object({
    name: z.string(),
    phase: z.string().meta({ example: "Running" }),
    ready: z.boolean(),
    restarts: z.int().min(0),
    ageSeconds: z.int().min(0),
  })
  .meta({ id: "PodView" });

export const ServiceViewSchema = z
  .object({
    name: z.string().meta({ example: "orders" }),
    desiredReplicas: z.int().min(0),
    readyReplicas: z.int().min(0),
    health: ServiceHealthSchema,
    latencyMs: z.int().min(0).optional(),
    pods: z.array(PodViewSchema),
  })
  .meta({ id: "ServiceView" });

export const RecentEventSchema = z
  .object({ ts: IsoDateTimeSchema, type: EventTypeSchema, summary: z.string() })
  .meta({ id: "RecentEvent" });

/** ARCHITECTURE §6. The SPA polls it every 2 s. */
export const DashboardSnapshotSchema = z
  .object({
    sessionId: UlidSchema,
    state: SessionStateSchema,
    generatedAt: IsoDateTimeSchema,
    elapsedSeconds: z.int().min(0),
    services: z.array(ServiceViewSchema),
    recentEvents: z.array(RecentEventSchema).max(20),
    availableActions: z.array(ActionTypeSchema),
    /** True when the snapshot is older than 10 s (the worker hasn't refreshed it). */
    stale: z.boolean().optional(),
  })
  .meta({ id: "DashboardSnapshot" });
export type DashboardSnapshot = z.infer<typeof DashboardSnapshotSchema>;

export function registerDashboardOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: "get",
    path: "/api/sessions/{sessionId}/dashboard",
    tags: ["dashboard"],
    summary: "Live view of the mock system for a session",
    security: [{ [BEARER_AUTH]: [] }],
    request: { params: SessionParamsSchema },
    responses: {
      200: { description: "Snapshot", ...jsonContent(DashboardSnapshotSchema) },
      ...errorResponses(400, 401, 404),
    },
  });
}
