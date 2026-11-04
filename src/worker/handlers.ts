import type { Clock } from "../platform/clock.js";
import type { Logger } from "../platform/logger.js";
import {
  isPenalized,
  isValidFix,
  type QueueMessage,
  type SystemMessage,
  type UserMessage,
} from "../modules/actions/index.js";
import type { HealthStreakStore } from "../modules/dashboard/index.js";
import type { MockClusterGateway } from "../modules/mock-cluster/index.js";
import type { Orchestration } from "../modules/orchestration/index.js";
import type { Scenario, ScenariosRepo } from "../modules/scenarios/index.js";
import { isTerminal, type Session, type SessionsRepo } from "../modules/sessions/index.js";
import { resetToBaseline } from "./reset.js";

export type HandlerDeps = {
  sessions: SessionsRepo;
  scenarios: ScenariosRepo;
  cluster: MockClusterGateway;
  orchestration: Orchestration;
  streaks: HealthStreakStore;
  clock: Clock;
  logger: Logger;
};

/**
 * Worker side of `user-actions` (ARCHITECTURE §5, BE-090/091/092/102). Every handler re-reads
 * the session and skips (acks) a message that no longer applies, so redelivery and late
 * messages are harmless. Without Redis (MVP) there is no `action:{id}` key: a crash between the
 * k8s patch and the counter update can count an action twice on redelivery (D-31).
 */
export function createMessageHandler(deps: HandlerDeps): (message: QueueMessage) => Promise<void> {
  async function load(message: {
    userId: string;
    sessionId: string;
  }): Promise<{ session: Session; scenario: Scenario } | undefined> {
    const session = await deps.sessions.get(message);
    if (!session) {
      deps.logger.warn({ sessionId: message.sessionId }, "message for an unknown session; skipped");
      return undefined;
    }
    const scenario = await deps.scenarios.get(session.scenarioId);
    if (!scenario) {
      deps.logger.error(
        { sessionId: session.sessionId, scenarioId: session.scenarioId },
        "unknown scenario; skipped",
      );
      return undefined;
    }
    return { session, scenario };
  }

  async function handleUser(message: UserMessage): Promise<void> {
    const log = deps.logger.child({
      sessionId: message.sessionId,
      actionId: message.actionId,
      type: message.type,
    });
    const loaded = await load(message);
    if (!loaded) return;
    const { session, scenario } = loaded;
    if (isTerminal(session.state)) {
      log.info({ state: session.state }, "session already ended; action skipped");
      return;
    }
    const key = { userId: session.userId, sessionId: session.sessionId };
    const now = deps.clock.now();

    switch (message.type) {
      case "ACKNOWLEDGE": {
        // Before the fault it's recorded as an action but doesn't start TTD (§5).
        const first =
          session.state === "INCIDENT_ACTIVE" &&
          (await deps.sessions.markAcknowledged(key, new Date(message.requestedAt)));
        await deps.sessions.incrementCounters(key, { actions: 1, wrong: 0 }, now);
        log.info({ first }, "acknowledged");
        return;
      }
      case "RESTART_DEPLOYMENT":
      case "SCALE_DEPLOYMENT": {
        if (session.state !== "INCIDENT_ACTIVE" || !scenario.targets.includes(message.target)) {
          log.warn(
            { state: session.state, target: message.target },
            "action no longer applies; skipped",
          );
          return;
        }
        if (message.type === "SCALE_DEPLOYMENT") {
          await deps.cluster.scale(message.target, message.params.replicas);
        } else {
          await deps.cluster.restart(message.target);
        }
        const valid = isValidFix(scenario, message);
        if (valid) await deps.sessions.markValidFix(key, now);
        const wrong = !valid && isPenalized(message) ? 1 : 0;
        await deps.sessions.incrementCounters(key, { actions: 1, wrong }, now);
        log.info({ target: message.target, valid }, "action applied");
        return;
      }
      case "ABANDON": {
        const result = await deps.orchestration.failTask({
          key,
          from: session.state,
          reason: "ABANDONED",
          at: now,
        });
        log.info({ result }, "session abandoned");
        return;
      }
    }
  }

  /** §4.2 step 7: reset the mock system to the scenario baseline and drop per-session state. */
  async function handleEnded(message: Extract<SystemMessage, { type: "SESSION_ENDED" }>) {
    const log = deps.logger.child({ sessionId: message.sessionId });
    await deps.streaks.clear(message.sessionId);
    const loaded = await load(message);
    if (!loaded) return;
    // Throwing leaves the message for a retry (and the DLQ after 3).
    await resetToBaseline(deps.cluster, loaded.scenario, log);
    log.info(
      { outcome: message.outcome, reason: message.reason },
      "session ended; mock system reset",
    );
  }

  return async (message) => {
    if (message.kind === "USER") return handleUser(message);
    if (message.type === "SESSION_ENDED") return handleEnded(message);
    // AWAIT_FIX arrives with Step Functions in M2 (§8.4a); acked so it never reaches the DLQ.
    deps.logger.warn(
      { sessionId: message.sessionId },
      "AWAIT_FIX is not handled before M2; skipped",
    );
  };
}
