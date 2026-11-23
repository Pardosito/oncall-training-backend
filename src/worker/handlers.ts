import type { Clock } from "../platform/clock.js";
import type { Lock } from "../platform/lock.js";
import type { Logger } from "../platform/logger.js";
import {
  isPenalized,
  isValidFix,
  type QueueMessage,
  type SystemMessage,
  type UserMessage,
} from "../modules/actions/index.js";
import type { HealthStreakStore, SnapshotStore } from "../modules/dashboard/index.js";
import {
  type EventFlusher,
  eventIds,
  type EventLog,
  type EventRecorder,
} from "../modules/events/index.js";
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
  /** The global lock, when Redis is configured; released on `SESSION_ENDED`. */
  lock?: Lock;
  /** `dashboard:{id}`, deleted on `SESSION_ENDED` (it would expire within 10 s anyway). */
  snapshots?: SnapshotStore;
  /** The session event log (D-20), when Redis is configured: recorded, flushed, then deleted. */
  events?: { recorder: EventRecorder; log: EventLog; flusher: EventFlusher };
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
        if (first) {
          await deps.events?.recorder.record({
            ts: message.requestedAt,
            ...eventIds(session),
            type: "ACKNOWLEDGED",
          });
        }
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
        await deps.events?.recorder.record({
          ts: now,
          ...eventIds(session),
          type: "ACTION",
          action: message.type,
          target: message.target,
          params: message.type === "SCALE_DEPLOYMENT" ? message.params : undefined,
          valid,
        });
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
        // D-32: abandoned during the warmup, the session ends now but its SESSION_ENDED only
        // comes when the execution does. Free the lock now so a new session can start; the
        // monitor resets the mock system to baseline during the new session's warmup anyway.
        if (result === "ok" && session.state === "STARTING" && deps.lock) {
          await deps.lock.release(session.sessionId);
        }
        return;
      }
    }
  }

  /**
   * §4.2 step 7: flush the event log to S3, reset the mock system to the scenario baseline, drop
   * per-session state, then release the lock. A failed flush or reset throws before the release. A failed reset throws before the release: the message is retried and the
   * lock keeps the next session from starting on a broken system (after 3 tries the message goes
   * to the DLQ and the lock's TTL frees it). The release is compare-and-delete, so a late or
   * redelivered message can't free a lock the next session holds.
   */
  async function handleEnded(message: Extract<SystemMessage, { type: "SESSION_ENDED" }>) {
    const log = deps.logger.child({ sessionId: message.sessionId });
    await endSession(message, log);
    if (deps.lock && (await deps.lock.release(message.sessionId))) log.info("lock released");
  }

  async function endSession(
    message: Extract<SystemMessage, { type: "SESSION_ENDED" }>,
    log: Logger,
  ): Promise<void> {
    await deps.streaks.clear(message.sessionId);
    await deps.snapshots?.clear(message.sessionId);
    const loaded = await load(message);
    if (!loaded) return;
    await flushEvents(message, loaded.session, log);
    // A late SESSION_ENDED (a session abandoned during its warmup ends when its execution
    // does) must not undo the fault of the session that started since. With Redis the lock
    // holder is that session; without it (MVP) a scan finds it (D-30).
    const activeSessionId = deps.lock
      ? await deps.lock.holder()
      : ((await deps.sessions.findActive())?.sessionId ?? null);
    if (activeSessionId && activeSessionId !== message.sessionId) {
      log.warn(
        { activeSessionId, outcome: message.outcome },
        "session ended while another one is running; mock system not reset",
      );
      await deps.events?.log.clear(message.sessionId);
      return;
    }
    // Throwing leaves the message for a retry (and the DLQ after 3).
    await resetToBaseline(deps.cluster, loaded.scenario, log);
    // Only now: a retry after a failed reset must upload the same full log again.
    await deps.events?.log.clear(message.sessionId);
    log.info(
      { outcome: message.outcome, reason: message.reason },
      "session ended; mock system reset",
    );
  }

  /**
   * D-20: add the FAILED line (RESOLVED and SCORED come from the monitor), then upload the
   * buffer. An empty buffer means this session was already flushed and cleaned up (a
   * redelivered message) or Redis lost it: nothing is recorded or written, so the stored log is
   * never replaced by a one-line one. An upload error throws: the message is retried.
   */
  async function flushEvents(
    message: Extract<SystemMessage, { type: "SESSION_ENDED" }>,
    session: Session,
    log: Logger,
  ): Promise<void> {
    if (!deps.events) return;
    const [last] = await deps.events.log.recent(session.sessionId, 1);
    if (!last) {
      log.info("no buffered events; nothing to flush");
      return;
    }
    if (message.outcome === "FAILED" && last.type !== "FAILED") {
      await deps.events.recorder.record({
        ts: session.endedAt ?? deps.clock.now(),
        ...eventIds(session),
        type: "FAILED",
      });
    }
    await deps.events.flusher.flush(session);
  }

  /**
   * §8.4a (D-13): store the state machine's task token on the session. If the session already
   * ended (abandoned during the warmup) or is unknown, fail the task right away, so the
   * execution ends and still sends SESSION_ENDED instead of waiting for its timeout.
   */
  async function handleAwaitFix(message: Extract<SystemMessage, { type: "AWAIT_FIX" }>) {
    const log = deps.logger.child({ sessionId: message.sessionId });
    const key = { userId: message.userId, sessionId: message.sessionId };
    const now = deps.clock.now();
    const session = await deps.sessions.get(key);
    if (session && (await deps.sessions.setTaskToken(key, message.taskToken, now))) {
      log.info({ state: session.state }, "task token stored");
      return;
    }
    const result = await deps.orchestration.failTask({
      key,
      taskToken: message.taskToken,
      from: session?.state ?? "STARTING",
      reason: session?.failureReason ?? "ABANDONED",
      at: now,
    });
    log.info(
      { state: session?.state ?? "unknown", result },
      "AWAIT_FIX for an ended session; task failed",
    );
  }

  return async (message) => {
    if (message.kind === "USER") return handleUser(message);
    if (message.type === "SESSION_ENDED") return handleEnded(message);
    return handleAwaitFix(message);
  };
}
