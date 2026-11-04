import type { Clock } from "../platform/clock.js";
import type { Logger } from "../platform/logger.js";
import {
  allServicesUp,
  type HealthStreakStore,
  isResolved,
  observeMockSystem,
} from "../modules/dashboard/index.js";
import type { MockClusterGateway } from "../modules/mock-cluster/index.js";
import type { Orchestration } from "../modules/orchestration/index.js";
import type { ScenariosRepo } from "../modules/scenarios/index.js";
import { computeScore } from "../modules/scoring/index.js";
import { type SessionsRepo, timeoutOf } from "../modules/sessions/index.js";
import { resetToBaseline } from "./reset.js";

export const MONITOR_INTERVAL_MS = 2_000;
/** The pre-fault reset only runs while the fault is at least this far away (D-31). */
export const RESET_SAFETY_SECONDS = 5;

export type MonitorDeps = {
  sessions: SessionsRepo;
  scenarios: ScenariosRepo;
  cluster: MockClusterGateway;
  orchestration: Orchestration;
  streaks: HealthStreakStore;
  clock: Clock;
  logger: Logger;
};

export type TickResult = "idle" | "timed-out" | "waiting" | "watching" | "resolved";

/**
 * One monitor pass (BE-100/101, MVP shape): find the active session (no lock without Redis,
 * D-30), enforce its timeout (the state machine's job in M2), and resolve it once a valid fix
 * was applied and every service was up on 2 consecutive checks. No session → no k8s calls.
 */
export function createMonitor(deps: MonitorDeps): { tick(): Promise<TickResult> } {
  // Sessions already reset to baseline while STARTING (in memory: a restart just resets again).
  const prepared = new Set<string>();
  return {
    async tick() {
      const session = await deps.sessions.findActive();
      if (!session) return "idle";
      const log = deps.logger.child({ sessionId: session.sessionId });
      const scenario = await deps.scenarios.get(session.scenarioId);
      if (!scenario) {
        log.error({ scenarioId: session.scenarioId }, "active session has an unknown scenario");
        return "idle";
      }
      const key = { userId: session.userId, sessionId: session.sessionId };
      const now = deps.clock.now();

      const timeout = timeoutOf(session, scenario);
      if (timeout && now >= timeout.at) {
        const result = await deps.orchestration.failTask({
          key,
          from: session.state,
          reason: timeout.reason,
          at: now,
        });
        await deps.streaks.clear(session.sessionId);
        log.info({ reason: timeout.reason, result }, "session timed out");
        return "timed-out";
      }
      const faultDueAt = Date.parse(session.createdAt) + scenario.warmupSeconds * 1000;
      const resetIsSafe = faultDueAt - now.getTime() >= RESET_SAFETY_SECONDS * 1000;
      if (session.state === "STARTING" && resetIsSafe && !prepared.has(session.sessionId)) {
        // Guard against a fault that landed on an already-ended session (injector race between
        // its GetItem and the apply): start every session from baseline. Safe because the
        // fault is delayed by the warmup; never within 5 s of it, so it can't undo a fault the
        // injector applied before flipping the session to INCIDENT_ACTIVE.
        await resetToBaseline(deps.cluster, scenario, log);
        prepared.add(session.sessionId);
        log.info("mock system reset to baseline before the fault");
      }
      if (session.state !== "INCIDENT_ACTIVE" || !session.faultInjectedAt) return "waiting";

      const observation = await observeMockSystem(deps.cluster, scenario.targets);
      const consecutiveHealthy = await deps.streaks.record(
        session.sessionId,
        allServicesUp(observation, scenario.targets),
      );
      if (!isResolved({ ...session, consecutiveHealthy })) return "watching";

      const resolvedAt = now.toISOString();
      const { ttdSeconds, ttrSeconds, score } = computeScore({
        faultInjectedAt: session.faultInjectedAt,
        acknowledgedAt: session.acknowledgedAt,
        resolvedAt,
        wrongActions: session.wrongActions,
        scoring: scenario.scoring,
      });
      const result = await deps.orchestration.completeTask({
        key,
        output: {
          resolvedAt,
          ttdSeconds,
          ttrSeconds,
          wrongActions: session.wrongActions,
          actionsCount: session.actionsCount,
          score,
        },
      });
      await deps.streaks.clear(session.sessionId);
      log.info({ score, ttdSeconds, ttrSeconds, result }, "session resolved");
      return "resolved";
    },
  };
}

/** Runs `tick` every 2 s until `signal` aborts; a failing tick is logged and the loop goes on. */
export async function runMonitor(deps: {
  monitor: { tick(): Promise<TickResult> };
  logger: Logger;
  signal: AbortSignal;
  intervalMs?: number;
}): Promise<void> {
  const log = deps.logger.child({ loop: "monitor" });
  const intervalMs = deps.intervalMs ?? MONITOR_INTERVAL_MS;
  log.info("monitor started");
  while (!deps.signal.aborted) {
    try {
      await deps.monitor.tick();
    } catch (error) {
      log.error({ err: error }, "monitor tick failed");
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      deps.signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
    });
  }
  log.info("monitor stopped");
}
