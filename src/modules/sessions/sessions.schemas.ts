import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
  BEARER_AUTH,
  errorResponses,
  IsoDateTimeSchema,
  jsonContent,
  UlidSchema,
} from "../../openapi/registry.js";

/** ARCHITECTURE §4.1. `RESOLVED` and `FAILED` are terminal. */
export const SessionStateSchema = z
  .enum(["STARTING", "INCIDENT_ACTIVE", "RESOLVED", "FAILED"])
  .meta({ id: "SessionState" });
export type SessionState = z.infer<typeof SessionStateSchema>;

/** Why a session failed (§8.4 `reason`). */
export const FailureReasonSchema = z
  .enum(["TIMEOUT", "ABANDONED", "ERROR"])
  .meta({ id: "FailureReason" });
export type FailureReason = z.infer<typeof FailureReasonSchema>;

/**
 * The session as the rest of the code sees it (camelCase). Only the repo maps it to the
 * snake_case item (§7.1). The Step Functions task token never appears here.
 */
export const SessionSchema = z.object({
  userId: z.string().min(1),
  sessionId: UlidSchema,
  username: z.string().min(1),
  scenarioId: z.string().min(1),
  state: SessionStateSchema,
  executionArn: z.string().optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  faultInjectedAt: IsoDateTimeSchema.optional(),
  acknowledgedAt: IsoDateTimeSchema.optional(),
  validFixAppliedAt: IsoDateTimeSchema.optional(),
  wrongActions: z.int().min(0),
  actionsCount: z.int().min(0),
  score: z.number().optional(),
  ttdSeconds: z.int().optional(),
  ttrSeconds: z.int().optional(),
  endedAt: IsoDateTimeSchema.optional(),
  failureReason: FailureReasonSchema.optional(),
});
export type Session = z.infer<typeof SessionSchema>;

/** What the owner sees (§6). No `userId`, `username` or internal fields. */
export const SessionViewSchema = z
  .object({
    sessionId: UlidSchema,
    scenarioId: z.string(),
    state: SessionStateSchema,
    createdAt: IsoDateTimeSchema,
    faultInjectedAt: IsoDateTimeSchema.optional(),
    acknowledgedAt: IsoDateTimeSchema.optional(),
    endedAt: IsoDateTimeSchema.optional(),
    score: z.number().optional(),
    ttdSeconds: z.int().optional(),
    ttrSeconds: z.int().optional(),
    wrongActions: z.int().optional(),
    actionsCount: z.int().optional(),
    failureReason: FailureReasonSchema.optional(),
  })
  .meta({ id: "SessionView" });
export type SessionView = z.infer<typeof SessionViewSchema>;

export const CreateSessionBodySchema = z
  .object({ scenarioId: z.string().min(1).meta({ example: "orders-down" }) })
  .meta({ id: "CreateSessionBody" });
export type CreateSessionBody = z.infer<typeof CreateSessionBodySchema>;

export const CreateSessionResponseSchema = z
  .object({ sessionId: UlidSchema })
  .meta({ id: "CreateSessionResponse" });

export const SessionParamsSchema = z.object({ sessionId: UlidSchema });

export function registerSessionsOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: "post",
    path: "/api/sessions",
    tags: ["sessions"],
    summary: "Start a session",
    description:
      "Starts the scenario for the caller. Returns 409 `SESSION_BUSY` with `details.retryAfterSeconds` while another session holds the global lock (not enforced in the Nov 5 MVP).",
    security: [{ [BEARER_AUTH]: [] }],
    request: { body: { required: true, ...jsonContent(CreateSessionBodySchema) } },
    responses: {
      201: { description: "Session created", ...jsonContent(CreateSessionResponseSchema) },
      ...errorResponses(400, 401, 404, 409),
    },
  });
  registry.registerPath({
    method: "get",
    path: "/api/sessions/{sessionId}",
    tags: ["sessions"],
    summary: "Get one of the caller's sessions",
    security: [{ [BEARER_AUTH]: [] }],
    request: { params: SessionParamsSchema },
    responses: {
      200: { description: "Session", ...jsonContent(SessionViewSchema) },
      ...errorResponses(400, 401, 404),
    },
  });
}
