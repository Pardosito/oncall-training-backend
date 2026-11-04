import { ulid } from "ulid";
import type { Clock } from "../../platform/clock.js";
import { conflict, notFound } from "../../platform/errors.js";
import type { Logger } from "../../platform/logger.js";
import type { AuthUser } from "../auth/index.js";
import type { Orchestration } from "../orchestration/index.js";
import type { ScenariosRepo } from "../scenarios/index.js";
import type { SessionsRepo } from "./sessions.repo.js";
import type { Session } from "./sessions.schemas.js";
import { latestEndOf } from "./sessions.timeouts.js";

export type SessionsService = ReturnType<typeof createSessionsService>;

export function createSessionsService(deps: {
  sessions: SessionsRepo;
  scenarios: ScenariosRepo;
  orchestration: Orchestration;
  clock: Clock;
  logger: Logger;
  /** `MOCK_NAMESPACE`, copied into the fault target. */
  namespace: string;
  newId?: () => string;
}) {
  const newId = deps.newId ?? (() => ulid());

  /** 409 `SESSION_BUSY` while any session is active (D-05; the MVP checks DynamoDB, D-30). */
  async function assertNoActiveSession(): Promise<void> {
    const active = await deps.sessions.findActive();
    if (!active) return;
    const scenario = await deps.scenarios.get(active.scenarioId);
    const retryAfterSeconds = scenario
      ? Math.max(
          1,
          Math.ceil((latestEndOf(active, scenario).getTime() - deps.clock.now().getTime()) / 1000),
        )
      : 60;
    throw conflict("SESSION_BUSY", "A scenario is already running.", { retryAfterSeconds });
  }

  return {
    /** ARCHITECTURE §4.2 step 1. */
    async startSession(user: AuthUser, scenarioId: string): Promise<Session> {
      const scenario = await deps.scenarios.get(scenarioId);
      if (!scenario) throw notFound("Scenario not found.");
      await assertNoActiveSession();

      const now = deps.clock.now();
      const session: Session = {
        userId: user.userId,
        sessionId: newId(),
        username: user.username,
        scenarioId,
        state: "STARTING",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        wrongActions: 0,
        actionsCount: 0,
      };
      await deps.sessions.create(session);
      const log = deps.logger.child({ sessionId: session.sessionId, userId: user.userId });

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
        throw error;
      }

      log.info({ scenarioId }, "session started");
      return session;
    },

    /** The caller's session; someone else's id is a 404 (ARCHITECTURE §3). */
    async getSession(user: AuthUser, sessionId: string): Promise<Session> {
      const session = await deps.sessions.get({ userId: user.userId, sessionId });
      if (!session) throw notFound("Session not found.");
      return session;
    },
  };
}
