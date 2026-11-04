import type { Clock } from "../../platform/clock.js";
import { notFound } from "../../platform/errors.js";
import type { Logger } from "../../platform/logger.js";
import type { AuthUser } from "../auth/index.js";
import type { MockClusterGateway } from "../mock-cluster/index.js";
import type { ScenariosRepo } from "../scenarios/index.js";
import { isTerminal, type SessionsRepo } from "../sessions/index.js";
import { buildSnapshot, eventsFromSession } from "./dashboard.builder.js";
import { observeMockSystem } from "./dashboard.observe.js";
import type { DashboardSnapshot } from "./dashboard.schemas.js";

export type DashboardService = ReturnType<typeof createDashboardService>;

/**
 * Nov 5 MVP (BE-130): the snapshot is built on each request from the session item and a live
 * read of the mock system; there is no Redis cache. Terminal sessions get a minimal final
 * snapshot (no services), and a failed cluster read gives the same with `stale: true`.
 */
export function createDashboardService(deps: {
  sessions: SessionsRepo;
  scenarios: ScenariosRepo;
  cluster: MockClusterGateway;
  clock: Clock;
  logger: Logger;
}) {
  return {
    async getSnapshot(user: AuthUser, sessionId: string): Promise<DashboardSnapshot> {
      const session = await deps.sessions.get({ userId: user.userId, sessionId });
      if (!session) throw notFound("Session not found.");
      const scenario = await deps.scenarios.get(session.scenarioId);
      if (!scenario) throw notFound("Scenario not found.");

      const base = {
        session,
        scenario,
        events: eventsFromSession(session),
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
