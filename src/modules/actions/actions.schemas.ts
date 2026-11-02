import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
  BEARER_AUTH,
  errorResponses,
  IsoDateTimeSchema,
  jsonContent,
  UlidSchema,
} from "../../openapi/registry.js";
import { ReplicasSchema } from "../scenarios/index.js";
import { SessionParamsSchema } from "../sessions/index.js";

const TargetSchema = z.string().min(1).meta({ example: "orders" });

const AcknowledgeAction = z.object({ type: z.literal("ACKNOWLEDGE") });
const RestartAction = z.object({ type: z.literal("RESTART_DEPLOYMENT"), target: TargetSchema });
const ScaleAction = z.object({
  type: z.literal("SCALE_DEPLOYMENT"),
  target: TargetSchema,
  params: z.object({ replicas: ReplicasSchema }),
});

/**
 * Body of `POST /api/sessions/:id/actions` (ARCHITECTURE §5). Only panel actions that change
 * state: `VIEW_LOGS` is a GET, `ABANDON` has its own route, `SESSION_ENDED` never comes from HTTP.
 */
export const ActionRequestSchema = z
  .discriminatedUnion("type", [AcknowledgeAction, RestartAction, ScaleAction])
  .meta({ id: "ActionRequest" });
export type ActionRequest = z.infer<typeof ActionRequestSchema>;

export const ActionAcceptedResponseSchema = z
  .object({ actionId: UlidSchema })
  .meta({ id: "ActionAccepted" });

const userMessageBase = {
  kind: z.literal("USER"),
  actionId: UlidSchema,
  sessionId: UlidSchema,
  userId: z.string().min(1),
  requestedAt: IsoDateTimeSchema,
};

/** `USER` message on `user-actions.fifo` (§8.5): an action request plus routing fields, or ABANDON. */
export const UserMessageSchema = z.discriminatedUnion("type", [
  AcknowledgeAction.extend(userMessageBase),
  RestartAction.extend(userMessageBase),
  ScaleAction.extend(userMessageBase),
  z.object({ type: z.literal("ABANDON"), ...userMessageBase }),
]);
export type UserMessage = z.infer<typeof UserMessageSchema>;

const systemMessageBase = {
  kind: z.literal("SYSTEM"),
  sessionId: UlidSchema,
  userId: z.string().min(1),
};

/** `SYSTEM` messages from the state machine (§8.4, infra §7). Not sent in the Nov 5 MVP. */
export const SystemMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("SESSION_ENDED"),
    ...systemMessageBase,
    outcome: z.enum(["RESOLVED", "FAILED"]),
    reason: z.enum(["TIMEOUT", "ABANDONED", "ERROR"]).nullable(),
  }),
  z.object({ type: z.literal("AWAIT_FIX"), ...systemMessageBase, taskToken: z.string().min(1) }),
]);
export type SystemMessage = z.infer<typeof SystemMessageSchema>;

/** Everything the worker may receive from `user-actions.fifo`. */
export const QueueMessageSchema = z.discriminatedUnion("kind", [
  UserMessageSchema,
  SystemMessageSchema,
]);
export type QueueMessage = z.infer<typeof QueueMessageSchema>;

export function registerActionsOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: "post",
    path: "/api/sessions/{sessionId}/actions",
    tags: ["actions"],
    summary: "Queue an action on the mock system",
    description:
      "The worker applies actions in order; the effect shows up in the dashboard once observed (no optimistic updates).",
    security: [{ [BEARER_AUTH]: [] }],
    request: {
      params: SessionParamsSchema,
      body: { required: true, ...jsonContent(ActionRequestSchema) },
    },
    responses: {
      202: { description: "Action queued", ...jsonContent(ActionAcceptedResponseSchema) },
      ...errorResponses(400, 401, 404, 409, 422),
    },
  });
}
