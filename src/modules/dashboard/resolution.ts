import type { Redis } from "ioredis";
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

/** Counts consecutive all-healthy checks per session (`session:{id}:health` in Redis). */
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

/** ARCHITECTURE §7.2: outlives any incident; a stale streak just expires. */
export const HEALTH_STREAK_TTL_SECONDS = 60 * 60;
export const healthStreakKey = (sessionId: string) => `session:${sessionId}:health`;

/**
 * BE-099: `INCR` on a healthy check, reset to 0 on an unhealthy one, `EX 3600` either way. In
 * Redis the streak survives a worker restart, so a restart no longer delays resolution.
 */
export function createRedisHealthStreakStore(deps: {
  redis: Pick<Redis, "multi" | "set" | "del">;
  /** Overridable so integration tests don't touch dev keys. */
  keyFor?: (sessionId: string) => string;
}): HealthStreakStore {
  const keyFor = deps.keyFor ?? healthStreakKey;
  return {
    async record(sessionId, allHealthy) {
      const key = keyFor(sessionId);
      if (!allHealthy) {
        await deps.redis.set(key, "0", "EX", HEALTH_STREAK_TTL_SECONDS);
        return 0;
      }
      const results = await deps.redis
        .multi()
        .incr(key)
        .expire(key, HEALTH_STREAK_TTL_SECONDS)
        .exec();
      const [incrError, count] = results?.[0] ?? [new Error("streak update aborted"), null];
      if (incrError) throw incrError;
      return Number(count);
    },
    async clear(sessionId) {
      await deps.redis.del(keyFor(sessionId));
    },
  };
}
