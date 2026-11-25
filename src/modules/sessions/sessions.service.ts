import { ulid } from "ulid";
import type { Clock } from "../../platform/clock.js";
import { conflict, notFound } from "../../platform/errors.js";
import type { Lock } from "../../platform/lock.js";
import type { Logger } from "../../platform/logger.js";
import type { AuthUser } from "../auth/index.js";
import { eventIds, type EventRecorder } from "../events/index.js";
import type { Orchestration } from "../orchestration/index.js";
import type { Scenario, ScenariosRepo } from "../scenarios/index.js";
import type { SessionsRepo } from "./sessions.repo.js";
import type { Session } from "./sessions.schemas.js";
import { latestEndOf, lockTtlMs } from "./sessions.timeouts.js";

export type SessionsService = ReturnType<typeof createSessionsService>;

export function createSessionsService(deps: {
  sessions: SessionsRepo;
  scenarios: ScenariosRepo;
  orchestration: Orchestration;
  clock: Clock;
  logger: Logger;
  /**
   * The global lock (D-05) when Redis is configured. Without it (Nov 5 MVP), the busy check
   * scans DynamoDB for an active session instead (D-30), which two simultaneous starts can race.
   */
  lock?: Lock;
  /** The session event log (D-20), when Redis is configured. */
  events?: EventRecorder;
  /** `MOCK_NAMESPACE`, copied into the fault target. */
  namespace: string;
  newId?: () => string;
}) {
  const newId = deps.newId ?? (() => ulid());

  const busy = (retryAfterSeconds: number) =>
    conflict("SESSION_BUSY", "A scenario is already running.", {
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)),
    });

  /** MVP busy check without Redis: 409 while any session is active (D-30). */
  async function assertNoActiveSession(): Promise<void> {
    const active = await deps.sessions.findActive();
    if (!active) return;
    const scenario = await deps.scenarios.get(active.scenarioId);
    throw busy(
      scenario ? (latestEndOf(active, scenario).getTime() - deps.clock.now().getTime()) / 1000 : 60,
    );
  }

  /** §4.2 step 1: take the lock for this session, or 409 with the lock's remaining TTL. */
  async function acquireLock(
    lock: Lock,
    sessionId: string,
    userId: string,
    scenario: Scenario,
  ): Promise<void> {
    if (await lock.acquire(sessionId, lockTtlMs(scenario), userId)) return;
    throw busy((await lock.remainingMs()) / 1000);
  }

  return {
    /** ARCHITECTURE §4.2 step 1. */
    async startSession(user: AuthUser, scenarioId: string): Promise<Session> {
      const scenario = await deps.scenarios.get(scenarioId);
      if (!scenario) throw notFound("Scenario not found.");
      const sessionId = newId();
      if (deps.lock) await acquireLock(deps.lock, sessionId, user.userId, scenario);
      else await assertNoActiveSession();

      const now = deps.clock.now();
      const session: Session = {
        userId: user.userId,
        sessionId,
        username: user.username,
        scenarioId,
        state: "STARTING",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        wrongActions: 0,
        actionsCount: 0,
      };
      const log = deps.logger.child({ sessionId, userId: user.userId });
      // §4.2 step 5: a start that fails frees the lock again, so the user can retry right away.
      const releaseLock = () =>
        deps.lock
          ?.release(sessionId)
          .catch((error: unknown) => log.error({ err: error }, "could not release the lock"));

      try {
        await deps.sessions.create(session);
      } catch (error) {
        await releaseLock();
        throw error;
      }

      try {
        await deps.orchestration.start({
          session,
          scenario,
          faultId: newId(),
          namespace: deps.namespace,
          at: now,
        });
      } catch (error) {
        log.error({ err: error }, "could not start the session; marking it FAILED");
        await deps.sessions
          .transition(session, {
            from: "STARTING",
            to: "FAILED",
            at: deps.clock.now(),
            set: { endedAt: deps.clock.now().toISOString(), failureReason: "ERROR" },
          })
          .catch((cleanupError: unknown) =>
            log.error({ err: cleanupError }, "could not mark the session FAILED"),
          );
        await releaseLock();
        throw error;
      }

      await deps.events?.record({ ts: now, ...eventIds(session), type: "SESSION_STARTED" });
      log.info({ scenarioId }, "session started");
      return session;
    },

    /** The caller's session; someone else's id is a 404 (ARCHITECTURE §3). */
    async getSession(user: AuthUser, sessionId: string): Promise<Session> {
      const session = await deps.sessions.get({ userId: user.userId, sessionId });
      if (!session) throw notFound("Session not found.");
      return session;
    },

    /** The caller's history, newest first (BE-069). Always keyed by the token's userId. */
    listMySessions(user: AuthUser, page: { limit: number; cursor?: string }) {
      return deps.sessions.listByUser(user.userId, page);
    },
  };
}
