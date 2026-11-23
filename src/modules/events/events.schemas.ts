import { z } from "zod";

/** Event types (ARCHITECTURE §7.4); also shown in the dashboard's `recentEvents`. */
export const EventTypeSchema = z
  .enum([
    "SESSION_STARTED",
    "FAULT_INJECTED",
    "ACKNOWLEDGED",
    "ACTION",
    "VIEW_LOGS",
    "RESOLVED",
    "FAILED",
    "SCORED",
  ])
  .meta({ id: "EventType" });
export type EventType = z.infer<typeof EventTypeSchema>;

/**
 * One line of `logs/…/{sessionId}.ndjson` (ARCHITECTURE §7.4), the contract with the Glue table
 * in the infra repo. snake_case because it is the stored format. Every key is always present
 * (null when not applicable) so the Glue schema stays flat; `params` is `struct<replicas:int>`.
 */
export const EventLineSchema = z.object({
  ts: z.iso.datetime(),
  user_id: z.string().min(1),
  session_id: z.string().min(1),
  scenario_id: z.string().min(1),
  type: EventTypeSchema,
  action: z.string().nullable(),
  target: z.string().nullable(),
  params: z.object({ replicas: z.int() }).nullable(),
  valid: z.boolean().nullable(),
  score: z.int().nullable(),
  ttd_seconds: z.int().nullable(),
  ttr_seconds: z.int().nullable(),
});
export type EventLine = z.infer<typeof EventLineSchema>;

/** What callers know about an event; everything else becomes null. */
export type EventInput = {
  ts: Date | string;
  userId: string;
  sessionId: string;
  scenarioId: string;
  type: EventType;
  action?: string | undefined;
  target?: string | undefined;
  params?: { replicas: number } | undefined;
  valid?: boolean | undefined;
  score?: number | undefined;
  ttdSeconds?: number | undefined;
  ttrSeconds?: number | undefined;
};

/** The ids every event carries, picked from a session (never spread a whole session). */
export function eventIds(session: { userId: string; sessionId: string; scenarioId: string }) {
  return { userId: session.userId, sessionId: session.sessionId, scenarioId: session.scenarioId };
}

/** Builds a full event line (BE-070): the same twelve keys every time, in §7.4 order. */
export function buildEvent(input: EventInput): EventLine {
  return EventLineSchema.parse({
    ts: input.ts instanceof Date ? input.ts.toISOString() : input.ts,
    user_id: input.userId,
    session_id: input.sessionId,
    scenario_id: input.scenarioId,
    type: input.type,
    action: input.action ?? null,
    target: input.target ?? null,
    params: input.params ? { replicas: input.params.replicas } : null,
    valid: input.valid ?? null,
    score: input.score === undefined ? null : Math.round(input.score),
    ttd_seconds: input.ttdSeconds ?? null,
    ttr_seconds: input.ttrSeconds ?? null,
  });
}
