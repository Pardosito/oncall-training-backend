import type { Clock } from "../../platform/clock.js";
import { notFound } from "../../platform/errors.js";
import type { Logger } from "../../platform/logger.js";
import type { AuthUser } from "../auth/index.js";
import { type EventLog, summarizeEvent } from "../events/index.js";
import type { MockClusterGateway } from "../mock-cluster/index.js";
import type { ScenariosRepo } from "../scenarios/index.js";
import { isTerminal, type Session, type SessionsRepo } from "../sessions/index.js";
import { buildSnapshot, eventsFromSession } from "./dashboard.builder.js";
import { observeMockSystem } from "./dashboard.observe.js";
import type { DashboardSnapshot } from "./dashboard.schemas.js";

export type DashboardService = ReturnType<typeof createDashboardService>;

/**
 * Nov 5 MVP (BE-130): the snapshot is built on each request from the session item and a live
 * read of the mock system; there is no Redis cache. Terminal sessions get a minimal final
 * snapshot (no services), and a failed cluster read gives the same with `stale: true`.
 * `recentEvents` come from the Redis event log when there is one (BE-072), otherwise (no Redis,
 * an empty or already flushed buffer, a Redis error) from the session item's timestamps.
 */
export function createDashboardService(deps: {
  sessions: SessionsRepo;
  scenarios: ScenariosRepo;
  cluster: MockClusterGateway;
  clock: Clock;
  logger: Logger;
  events?: EventLog;
}) {
  async function recentEvents(session: Session) {
    if (!deps.events) return eventsFromSession(session);
    try {
      const events = await deps.events.recent(session.sessionId);
      if (events.length > 0) {
        return events
          .reverse()
          .map((event) => ({ ts: event.ts, type: event.type, summary: summarizeEvent(event) }));
      }
    } catch (error) {
      deps.logger.warn(
        { err: error, sessionId: session.sessionId },
        "could not read the event log; events from the session item",
      );
    }
    return eventsFromSession(session);
  }

  return {
    async getSnapshot(user: AuthUser, sessionId: string): Promise<DashboardSnapshot> {
      const session = await deps.sessions.get({ userId: user.userId, sessionId });
      if (!session) throw notFound("Session not found.");
      const scenario = await deps.scenarios.get(session.scenarioId);
      if (!scenario) throw notFound("Scenario not found.");

      const base = {
        session,
        scenario,
        events: await recentEvents(session),
        now: deps.clock.now(),
      };
      const minimal = () => ({
        ...buildSnapshot({ ...base, deployments: [], pods: [], health: {} }),
        services: [],
      });

      if (isTerminal(session.state)) return minimal();
      try {
        return buildSnapshot({
          ...base,
          ...(await observeMockSystem(deps.cluster, scenario.targets)),
        });
      } catch (error) {
        deps.logger.warn(
          { err: error, sessionId },
          "could not read the mock system; stale snapshot",
        );
        return { ...minimal(), stale: true };
      }
    },
  };
}
