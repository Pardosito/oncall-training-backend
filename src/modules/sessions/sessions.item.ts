import { z } from "zod";
import {
  FailureReasonSchema,
  type Session,
  SessionSchema,
  SessionStateSchema,
} from "./sessions.schemas.js";

/** The DynamoDB item (ARCHITECTURE §7.1). snake_case lives only here and in the repo. */
const SessionItemSchema = z.object({
  user_id: z.string(),
  session_id: z.string(),
  username: z.string(),
  scenario_id: z.string(),
  state: SessionStateSchema,
  execution_arn: z.string().optional(),
  task_token: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  fault_injected_at: z.string().optional(),
  acknowledged_at: z.string().optional(),
  valid_fix_applied_at: z.string().optional(),
  wrong_actions: z.number().optional(),
  actions_count: z.number().optional(),
  score: z.number().optional(),
  ttd_seconds: z.number().optional(),
  ttr_seconds: z.number().optional(),
  ended_at: z.string().optional(),
  failure_reason: FailureReasonSchema.optional(),
});
export type SessionItem = z.infer<typeof SessionItemSchema>;

/** camelCase domain field → snake_case attribute, for every field a repo update may set. */
export const ATTRIBUTE: Record<keyof Session, keyof SessionItem> = {
  userId: "user_id",
  sessionId: "session_id",
  username: "username",
  scenarioId: "scenario_id",
  state: "state",
  executionArn: "execution_arn",
  createdAt: "created_at",
  updatedAt: "updated_at",
  faultInjectedAt: "fault_injected_at",
  acknowledgedAt: "acknowledged_at",
  validFixAppliedAt: "valid_fix_applied_at",
  wrongActions: "wrong_actions",
  actionsCount: "actions_count",
  score: "score",
  ttdSeconds: "ttd_seconds",
  ttrSeconds: "ttr_seconds",
  endedAt: "ended_at",
  failureReason: "failure_reason",
};

export function toItem(session: Session): SessionItem {
  const item: Record<string, unknown> = {};
  for (const [field, attribute] of Object.entries(ATTRIBUTE)) {
    const value = session[field as keyof Session];
    if (value !== undefined) item[attribute] = value;
  }
  return item as SessionItem;
}

/** Validates the raw item and maps it to the domain. `task_token` is dropped on purpose. */
export function fromItem(raw: unknown): Session {
  const item = SessionItemSchema.parse(raw);
  return SessionSchema.parse({
    userId: item.user_id,
    sessionId: item.session_id,
    username: item.username,
    scenarioId: item.scenario_id,
    state: item.state,
    executionArn: item.execution_arn,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    faultInjectedAt: item.fault_injected_at,
    acknowledgedAt: item.acknowledged_at,
    validFixAppliedAt: item.valid_fix_applied_at,
    wrongActions: item.wrong_actions ?? 0,
    actionsCount: item.actions_count ?? 0,
    score: item.score,
    ttdSeconds: item.ttd_seconds,
    ttrSeconds: item.ttr_seconds,
    endedAt: item.ended_at,
    failureReason: item.failure_reason,
  });
}
