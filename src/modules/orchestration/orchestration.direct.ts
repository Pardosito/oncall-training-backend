import type { Logger } from "../../platform/logger.js";
import type { MessageQueue } from "../../platform/queue.js";
import type { SystemMessage } from "../actions/index.js";
import {
  type FailureReason,
  type SessionKey,
  type SessionsRepo,
  SessionStateConflict,
} from "../sessions/index.js";
import type { Orchestration, TaskResult } from "./orchestration.js";
import type { FaultMessage } from "./orchestration.schemas.js";

/**
 * Nov 5 MVP orchestration (D-24, BE-128), no Step Functions:
 * - `start` sends `FAULT` to `faults`, delayed by `warmupSeconds` (max 900 s); the injector
 *   then moves the session to `INCIDENT_ACTIVE` (§8.3).
 * - `completeTask` / `failTask` write the terminal state themselves (the state machine's
 *   Persist step), then send `SESSION_ENDED` like the state machine would (D-29), so the worker
 *   resets the mock system through the same handler in both modes.
 * The worker's monitor loop enforces the timeouts the state machine would.
 */
export function createDirectOrchestration(deps: {
  sessions: SessionsRepo;
  queue: MessageQueue;
  userActionsQueueUrl: string;
  /** Only the api starts sessions; the worker has no `FAULTS_QUEUE_URL`. */
  faultsQueueUrl?: string;
  logger: Logger;
}): Orchestration {
  async function ended(
    key: SessionKey,
    outcome: "RESOLVED" | "FAILED",
    reason: FailureReason | null,
  ): Promise<void> {
    const message: SystemMessage = {
      kind: "SYSTEM",
      type: "SESSION_ENDED",
      ...key,
      outcome,
      reason,
    };
    await deps.queue.send(deps.userActionsQueueUrl, message, {
      groupId: key.sessionId,
      dedupId: `${key.sessionId}:ended`,
    });
  }

  async function guard(key: SessionKey, write: () => Promise<unknown>): Promise<TaskResult> {
    try {
      await write();
      return "ok";
    } catch (error) {
      if (error instanceof SessionStateConflict) {
        deps.logger.warn({ sessionId: key.sessionId }, "session already ended; nothing to do");
        return "already-ended";
      }
      throw error;
    }
  }

  return {
    async start({ session, scenario, faultId, namespace, at }) {
      if (!deps.faultsQueueUrl) throw new Error("FAULTS_QUEUE_URL is required to start sessions");
      // The MVP scenario has one fault; with several, the first one is injected.
      const [fault] = scenario.faults;
      if (!fault) throw new Error(`scenario ${scenario.id} has no faults`);
      const message: FaultMessage = {
        faultId,
        sessionId: session.sessionId,
        userId: session.userId,
        type: fault.type,
        target: { namespace, deployment: fault.target },
        sentAt: at.toISOString(),
      };
      await deps.queue.send(deps.faultsQueueUrl, message, { delaySeconds: scenario.warmupSeconds });
      return {};
    },

    async completeTask({ key, output }) {
      const result = await guard(key, () =>
        deps.sessions.transition(key, {
          from: "INCIDENT_ACTIVE",
          to: "RESOLVED",
          at: new Date(output.resolvedAt),
          set: {
            endedAt: output.resolvedAt,
            score: output.score,
            ttdSeconds: output.ttdSeconds,
            ttrSeconds: output.ttrSeconds,
          },
        }),
      );
      if (result === "ok") await ended(key, "RESOLVED", null);
      return result;
    },

    async failTask({ key, from, reason, at }) {
      const result = await guard(key, () =>
        deps.sessions.transition(key, {
          from,
          to: "FAILED",
          at,
          set: { endedAt: at.toISOString(), failureReason: reason },
        }),
      );
      if (result === "ok") await ended(key, "FAILED", reason);
      return result;
    },
  };
}
