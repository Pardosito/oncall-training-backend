import type { Clock } from "../platform/clock.js";
import type { Logger } from "../platform/logger.js";
import type { FakeMockCluster } from "../modules/mock-cluster/index.js";
import type { FaultMessage } from "../modules/orchestration/index.js";
import { type SessionsRepo, SessionStateConflict } from "../modules/sessions/index.js";

/**
 * Local stand-in for the infra injector (BE-105, ARCHITECTURE §8.3): moves the session to
 * `INCIDENT_ACTIVE` with `fault_injected_at`, conditional on `STARTING`, then breaks the fake
 * cluster. A session that ended during the warmup (abandoned) gets no fault.
 */
export function createFakeInjector(deps: {
  sessions: SessionsRepo;
  cluster: FakeMockCluster;
  clock: Clock;
  logger: Logger;
}): (message: FaultMessage) => Promise<void> {
  return async (message) => {
    const log = deps.logger.child({ sessionId: message.sessionId, faultId: message.faultId });
    const now = deps.clock.now();
    try {
      await deps.sessions.transition(message, {
        from: "STARTING",
        to: "INCIDENT_ACTIVE",
        at: now,
        set: { faultInjectedAt: now.toISOString() },
      });
    } catch (error) {
      if (error instanceof SessionStateConflict) {
        log.warn("session is not STARTING; fault skipped");
        return;
      }
      throw error;
    }
    deps.cluster.applyFault({ type: message.type, target: message.target.deployment });
    log.info({ type: message.type, target: message.target.deployment }, "fault injected (fake)");
  };
}
