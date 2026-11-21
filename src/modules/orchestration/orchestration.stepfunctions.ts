import {
  SendTaskFailureCommand,
  SendTaskSuccessCommand,
  type SFNClient,
  StartExecutionCommand,
} from "@aws-sdk/client-sfn";
import type { Logger } from "../../platform/logger.js";
import {
  type FailureReason,
  type SessionKey,
  type SessionsRepo,
  SessionStateConflict,
} from "../sessions/index.js";
import { type Orchestration, type TaskResult, TaskOutputSchema } from "./orchestration.js";
import { ExecutionInputSchema } from "./orchestration.schemas.js";

/** Error the state machine's `WaitForFix` catches as `ABANDONED` (infra ARCHITECTURE §6.1). */
export const ABANDONED_ERROR = "Abandoned";

/** The token was already used, timed out, or its execution ended: nothing left to answer. */
const ENDED_TASK_ERRORS = new Set(["TaskTimedOut", "InvalidToken", "TaskDoesNotExist"]);

const errorName = (error: unknown) => (error instanceof Error ? error.name : undefined);

/**
 * M2 orchestration (BE-062/063): the state machine `oncall-training-scenario` (infra §6) runs
 * warmup → FAULT → AWAIT_FIX → end state → SESSION_ENDED. The worker stores the task token from
 * `AWAIT_FIX` on the session (D-13); `completeTask` / `failTask` answer it. The state machine
 * writes `RESOLVED` / `FAILED` and owns the timeouts, so nothing here writes an end state except
 * an abandon that comes before the token (see `failTask`).
 */
export function createStepFunctionsOrchestration(deps: {
  sfn: Pick<SFNClient, "send">;
  stateMachineArn: string;
  sessions: SessionsRepo;
  logger: Logger;
}): Orchestration {
  const executionArnOf = (name: string) =>
    `${deps.stateMachineArn.replace(":stateMachine:", ":execution:")}:${name}`;

  /** Never logs the token. */
  async function answer(key: SessionKey, send: () => Promise<unknown>): Promise<TaskResult> {
    try {
      await send();
      return "ok";
    } catch (error) {
      const name = errorName(error);
      if (name && ENDED_TASK_ERRORS.has(name)) {
        deps.logger.warn(
          { sessionId: key.sessionId, error: name },
          "task token no longer valid; the execution already moved on",
        );
        return "already-ended";
      }
      throw error;
    }
  }

  return {
    async start({ session, scenario, faultId, namespace }) {
      // The MVP scenario has one fault; with several, the first one is injected.
      const [fault] = scenario.faults;
      if (!fault) throw new Error(`scenario ${scenario.id} has no faults`);
      const input = ExecutionInputSchema.parse({
        userId: session.userId,
        sessionId: session.sessionId,
        scenarioId: scenario.id,
        warmupSeconds: scenario.warmupSeconds,
        maxResolveSeconds: scenario.maxResolveSeconds,
        fault: { faultId, type: fault.type, target: { namespace, deployment: fault.target } },
      });
      try {
        const { executionArn } = await deps.sfn.send(
          new StartExecutionCommand({
            stateMachineArn: deps.stateMachineArn,
            name: session.sessionId,
            input: JSON.stringify(input),
          }),
        );
        return { executionArn: executionArn ?? executionArnOf(session.sessionId) };
      } catch (error) {
        // Same name = same session: a retried start is a success.
        if (errorName(error) === "ExecutionAlreadyExists") {
          deps.logger.warn({ sessionId: session.sessionId }, "execution already started");
          return { executionArn: executionArnOf(session.sessionId) };
        }
        throw error;
      }
    },

    async completeTask({ key, taskToken, output }) {
      const token = taskToken ?? (await deps.sessions.getTaskToken(key));
      // AWAIT_FIX hasn't been handled yet: the monitor tries again on its next tick.
      if (!token) throw new Error(`no task token for session ${key.sessionId} yet`);
      return answer(key, () =>
        deps.sfn.send(
          new SendTaskSuccessCommand({
            taskToken: token,
            output: JSON.stringify(TaskOutputSchema.parse(output)),
          }),
        ),
      );
    },

    async failTask({ key, taskToken, from, reason, at }) {
      const token = taskToken ?? (await deps.sessions.getTaskToken(key));
      if (!token) {
        // Abandon during the warmup: there's no token to fail yet. Write FAILED here; the
        // execution goes on, and when its AWAIT_FIX arrives for the ended session the worker
        // answers with SendTaskFailure, so SESSION_ENDED still comes from the state machine.
        // No StopExecution: it would skip SESSION_ENDED (infra ARCHITECTURE §6.1, D-29).
        try {
          await deps.sessions.transition(key, {
            from,
            to: "FAILED",
            at,
            set: { endedAt: at.toISOString(), failureReason: reason },
          });
          return "ok";
        } catch (error) {
          if (error instanceof SessionStateConflict) return "already-ended";
          throw error;
        }
      }
      return answer(key, () =>
        deps.sfn.send(
          new SendTaskFailureCommand({
            taskToken: token,
            error: taskError(reason),
            cause: `session ${reason.toLowerCase()}`,
          }),
        ),
      );
    },
  };
}

/** `Abandoned` maps to ABANDONED in the state machine; anything else ends up as ERROR there. */
function taskError(reason: FailureReason): string {
  return reason === "ABANDONED" ? ABANDONED_ERROR : reason;
}
