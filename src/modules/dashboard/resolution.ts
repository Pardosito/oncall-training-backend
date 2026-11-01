import type { Session } from "../sessions/index.js";

/** Healthy checks in a row needed before a session counts as resolved (D-07). */
export const REQUIRED_HEALTHY_CHECKS = 2;

/** D-07: `INCIDENT_ACTIVE`, a valid fix applied, and every service healthy twice in a row. */
export function isResolved(input: {
  state: Session["state"];
  validFixAppliedAt?: string | undefined;
  consecutiveHealthy: number;
}): boolean {
  return (
    input.state === "INCIDENT_ACTIVE" &&
    Boolean(input.validFixAppliedAt) &&
    input.consecutiveHealthy >= REQUIRED_HEALTHY_CHECKS
  );
}

/** Counts consecutive all-healthy checks per session. Redis-backed in M2 (`session:{id}:health`). */
export type HealthStreakStore = {
  /** Records one check and returns the current streak (reset to 0 on an unhealthy check). */
  record(sessionId: string, allHealthy: boolean): Promise<number>;
  clear(sessionId: string): Promise<void>;
};

/**
 * Nov 5 MVP (D-26): the streak lives in worker memory. Safe because the worker is a single
 * replica (D-08); a restart only resets the streak, which delays resolution by two checks.
 */
export function createInMemoryHealthStreakStore(): HealthStreakStore {
  const streaks = new Map<string, number>();
  return {
    record: (sessionId, allHealthy) => {
      const next = allHealthy ? (streaks.get(sessionId) ?? 0) + 1 : 0;
      streaks.set(sessionId, next);
      return Promise.resolve(next);
    },
    clear: (sessionId) => {
      streaks.delete(sessionId);
      return Promise.resolve();
    },
  };
}
