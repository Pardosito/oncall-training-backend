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
import type { SnapshotStore } from "./dashboard.snapshots.js";

type RecentEvent = DashboardSnapshot["recentEvents"][number];

/**
 * `recentEvents` from the Redis event log, newest first (BE-072); from the session item's
 * timestamps without Redis, with an empty or already flushed buffer, or on a Redis error.
 */
export async function loadRecentEvents(
  session: Session,
  events: EventLog | undefined,
  logger: Logger,
): Promise<RecentEvent[]> {
  if (!events) return eventsFromSession(session);
  try {
    const lines = await events.recent(session.sessionId);
    if (lines.length > 0) {
      return lines
        .reverse()
        .map((event) => ({ ts: event.ts, type: event.type, summary: summarizeEvent(event) }));
    }
  } catch (error) {
    logger.warn(
      { err: error, sessionId: session.sessionId },
      "could not read the event log; events from the session item",
    );
  }
  return eventsFromSession(session);
}

export type DashboardService = ReturnType<typeof createDashboardService>;

/**
 * Nov 5 MVP (BE-130): the snapshot is built on each request from the session item and a live
 * read of the mock system; there is no Redis cache. Terminal sessions get a minimal final
 * snapshot (no services), and a failed cluster read gives the same with `stale: true`.
 * With Redis (BE-097), an active session's snapshot is the one the worker's monitor stored, if
 * it is there and matches the session's state; otherwise it's built live as above.
 */
export function createDashboardService(deps: {
  sessions: SessionsRepo;
  scenarios: ScenariosRepo;
  cluster: MockClusterGateway;
  clock: Clock;
  logger: Logger;
  events?: EventLog;
  snapshots?: SnapshotStore;
}) {
  /** The monitor's snapshot, unless it's missing or from before a state change (≤ 2 s old). */
  async function cached(session: Session): Promise<DashboardSnapshot | null> {
    if (!deps.snapshots) return null;
    try {
      const snapshot = await deps.snapshots.get(session.sessionId);
      return snapshot?.state === session.state ? snapshot : null;
    } catch (error) {
      deps.logger.warn(
        { err: error, sessionId: session.sessionId },
        "could not read the snapshot; building it live",
      );
      return null;
    }
  }

  return {
    async getSnapshot(user: AuthUser, sessionId: string): Promise<DashboardSnapshot> {
      const session = await deps.sessions.get({ userId: user.userId, sessionId });
      if (!session) throw notFound("Session not found.");
      const scenario = await deps.scenarios.get(session.scenarioId);
      if (!scenario) throw notFound("Scenario not found.");
      if (!isTerminal(session.state)) {
        const snapshot = await cached(session);
        if (snapshot) return snapshot;
      }

      const base = {
        session,
        scenario,
        events: await loadRecentEvents(session, deps.events, deps.logger),
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
