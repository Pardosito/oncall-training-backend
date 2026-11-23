import type { Scenario } from "../scenarios/index.js";
import type { FailureReason, Session } from "./sessions.schemas.js";

/**
 * How long past `warmupSeconds` a session may stay `STARTING` before the worker fails it with
 * `ERROR` (the fault never landed: injector down, queue misconfigured). Direct mode only (D-24);
 * in M2 the state machine owns this.
 */
export const STARTING_GRACE_SECONDS = 120;

/** Slack on top of a session's longest run before its lock expires on its own (§4.2 step 1). */
export const LOCK_SLACK_SECONDS = 180;

/**
 * TTL of the global lock (BE-065): warmup + max resolve time + 3 min, so it outlives any
 * session (including cleanup) and frees itself if nobody releases it.
 */
export function lockTtlMs(scenario: Pick<Scenario, "warmupSeconds" | "maxResolveSeconds">): number {
  return (scenario.warmupSeconds + scenario.maxResolveSeconds + LOCK_SLACK_SECONDS) * 1000;
}

export type SessionTimeout = { at: Date; reason: FailureReason };

const plusSeconds = (iso: string, seconds: number) => new Date(Date.parse(iso) + seconds * 1000);

/** When an active session must be failed, and why. Undefined for terminal sessions. */
export function timeoutOf(
  session: Pick<Session, "state" | "createdAt" | "faultInjectedAt">,
  scenario: Pick<Scenario, "warmupSeconds" | "maxResolveSeconds">,
): SessionTimeout | undefined {
  if (session.state === "STARTING") {
    return {
      at: plusSeconds(session.createdAt, scenario.warmupSeconds + STARTING_GRACE_SECONDS),
      reason: "ERROR",
    };
  }
  if (session.state === "INCIDENT_ACTIVE") {
    const start = session.faultInjectedAt ?? session.createdAt;
    return { at: plusSeconds(start, scenario.maxResolveSeconds), reason: "TIMEOUT" };
  }
  return undefined;
}

/** Latest moment an active session can still be running; drives `retryAfterSeconds`. */
export function latestEndOf(
  session: Pick<Session, "state" | "createdAt" | "faultInjectedAt">,
  scenario: Pick<Scenario, "warmupSeconds" | "maxResolveSeconds">,
): Date {
  if (session.state === "INCIDENT_ACTIVE") return timeoutOf(session, scenario)?.at ?? new Date(0);
  return plusSeconds(
    session.createdAt,
    scenario.warmupSeconds + STARTING_GRACE_SECONDS + scenario.maxResolveSeconds,
  );
}
