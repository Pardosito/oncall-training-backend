import type { ActionType, Scenario } from "../scenarios/index.js";
import type { Session } from "../sessions/index.js";
import { isTerminal } from "../sessions/index.js";
import type { DeploymentStatus, HealthCheckResult, PodStatus } from "../mock-cluster/index.js";
import type { DashboardSnapshot, ServiceHealth } from "./dashboard.schemas.js";

/** A health check slower than this marks the service `degraded`. */
export const SLOW_HEALTH_CHECK_MS = 1000;
export const MAX_RECENT_EVENTS = 20;

type RecentEvent = DashboardSnapshot["recentEvents"][number];

/**
 * `down`: no ready replica, or the health check failed or timed out.
 * `degraded`: fewer ready replicas than desired, or the check took over 1 s.
 * `healthy`: otherwise.
 */
export function serviceHealth(
  deployment: Pick<DeploymentStatus, "desiredReplicas" | "readyReplicas"> | undefined,
  check: HealthCheckResult | undefined,
): ServiceHealth {
  if (!deployment || deployment.readyReplicas === 0 || !check?.healthy) return "down";
  if (deployment.readyReplicas < deployment.desiredReplicas) return "degraded";
  if ((check.latencyMs ?? 0) > SLOW_HEALTH_CHECK_MS) return "degraded";
  return "healthy";
}

/** Actions the panel may enable now: ACKNOWLEDGE before the fault, everything during, none after. */
export function availableActionsFor(
  session: Pick<Session, "state">,
  scenario: Pick<Scenario, "availableActions">,
): ActionType[] {
  if (isTerminal(session.state)) return [];
  if (session.state === "STARTING") {
    return scenario.availableActions.filter((action) => action === "ACKNOWLEDGE");
  }
  return [...scenario.availableActions];
}

/** MVP (BE-130): recent events derived from the session item's timestamps, newest first. */
export function eventsFromSession(session: Session): RecentEvent[] {
  const events: RecentEvent[] = [
    { ts: session.createdAt, type: "SESSION_STARTED", summary: "Session started" },
  ];
  if (session.faultInjectedAt) {
    events.push({
      ts: session.faultInjectedAt,
      type: "FAULT_INJECTED",
      summary: "Incident started",
    });
  }
  if (session.acknowledgedAt) {
    events.push({
      ts: session.acknowledgedAt,
      type: "ACKNOWLEDGED",
      summary: "Incident acknowledged",
    });
  }
  if (session.endedAt && session.state === "RESOLVED") {
    events.push({
      ts: session.endedAt,
      type: "RESOLVED",
      summary: `Resolved, score ${session.score ?? 0}`,
    });
  }
  if (session.endedAt && session.state === "FAILED") {
    const reason = session.failureReason ? ` (${session.failureReason.toLowerCase()})` : "";
    events.push({ ts: session.endedAt, type: "FAILED", summary: `Session failed${reason}` });
  }
  return events.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, MAX_RECENT_EVENTS);
}

function secondsSince(fromIso: string | undefined, now: Date): number {
  if (!fromIso) return 0;
  return Math.max(0, Math.floor((now.getTime() - new Date(fromIso).getTime()) / 1000));
}

export type SnapshotInput = {
  session: Session;
  scenario: Pick<Scenario, "targets" | "availableActions">;
  deployments: DeploymentStatus[];
  pods: PodStatus[];
  health: Record<string, HealthCheckResult>;
  events: RecentEvent[];
  now: Date;
};

/** Pure: mock-system state + session → `DashboardSnapshot` (only the scenario's targets). */
export function buildSnapshot(input: SnapshotInput): DashboardSnapshot {
  const { session, scenario, now } = input;
  const end = session.endedAt ? new Date(session.endedAt) : now;
  return {
    sessionId: session.sessionId,
    state: session.state,
    generatedAt: now.toISOString(),
    elapsedSeconds: secondsSince(session.faultInjectedAt ?? session.createdAt, end),
    services: scenario.targets.map((name) => {
      const deployment = input.deployments.find((d) => d.name === name);
      const check = input.health[name];
      return {
        name,
        desiredReplicas: deployment?.desiredReplicas ?? 0,
        readyReplicas: deployment?.readyReplicas ?? 0,
        health: serviceHealth(deployment, check),
        ...(check?.latencyMs !== undefined ? { latencyMs: Math.round(check.latencyMs) } : {}),
        pods: input.pods
          .filter((pod) => pod.deployment === name)
          .map((pod) => ({
            name: pod.name,
            phase: pod.phase,
            ready: pod.ready,
            restarts: pod.restarts,
            ageSeconds: secondsSince(pod.startedAt, now),
          })),
      };
    }),
    recentEvents: input.events.slice(0, MAX_RECENT_EVENTS),
    availableActions: availableActionsFor(session, scenario),
  };
}
