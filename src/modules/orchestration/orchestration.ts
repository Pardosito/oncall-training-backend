import { z } from "zod";
import { IsoDateTimeSchema } from "../../openapi/registry.js";
import type { Scenario } from "../scenarios/index.js";
import type { FailureReason, Session, SessionKey, SessionState } from "../sessions/index.js";

/** `SendTaskSuccess` output (ARCHITECTURE §8.2). */
export const TaskOutputSchema = z.object({
  resolvedAt: IsoDateTimeSchema,
  ttdSeconds: z.int().min(0),
  ttrSeconds: z.int().min(0),
  wrongActions: z.int().min(0),
  actionsCount: z.int().min(0),
  score: z.number(),
});
export type TaskOutput = z.infer<typeof TaskOutputSchema>;

export type StartInput = {
  session: Session;
  scenario: Scenario;
  faultId: string;
  /** Kubernetes namespace of the mock system (`MOCK_NAMESPACE`). */
  namespace: string;
  at: Date;
};

export type TaskResult = "ok" | "already-ended";

/**
 * Drives a session through warmup → fault → wait for fix → end. Step Functions in M2;
 * `direct` in the Nov 5 MVP (D-24). Both end with `SESSION_ENDED` on `user-actions` (§8.4).
 */
export type Orchestration = {
  start(input: StartInput): Promise<{ executionArn?: string }>;
  /** The session resolved: persist the score and end it. */
  completeTask(input: {
    key: SessionKey;
    taskToken?: string;
    output: TaskOutput;
  }): Promise<TaskResult>;
  /** The session failed (timeout, abandon, error): persist and end it. */
  failTask(input: {
    key: SessionKey;
    taskToken?: string;
    from: SessionState;
    reason: FailureReason;
    at: Date;
  }): Promise<TaskResult>;
};

type Call =
  | { method: "start"; input: StartInput }
  | { method: "completeTask"; input: Parameters<Orchestration["completeTask"]>[0] }
  | { method: "failTask"; input: Parameters<Orchestration["failTask"]>[0] };

/** Records calls; `failStart` makes `start` reject. For service tests. */
export function createFakeOrchestration(options: { failStart?: Error } = {}) {
  const calls: Call[] = [];
  const orchestration: Orchestration = {
    start(input) {
      calls.push({ method: "start", input });
      return options.failStart ? Promise.reject(options.failStart) : Promise.resolve({});
    },
    completeTask(input) {
      calls.push({ method: "completeTask", input });
      return Promise.resolve("ok");
    },
    failTask(input) {
      calls.push({ method: "failTask", input });
      return Promise.resolve("ok");
    },
  };
  return { orchestration, calls };
}
