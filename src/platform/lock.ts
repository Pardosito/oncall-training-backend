import type { Redis } from "ioredis";
import type { Clock } from "./clock.js";

/**
 * The global session lock (D-05, ARCHITECTURE §4.2 steps 1 and 7.4, §7.2): one active session
 * at a time, held by its sessionId with a TTL as the last resort if nobody releases it.
 */
export type Lock = {
  /** Takes the lock for `sessionId` if it's free. */
  acquire(sessionId: string, ttlMs: number): Promise<boolean>;
  /** The sessionId holding the lock, or null. */
  holder(): Promise<string | null>;
  /** Milliseconds until the lock expires; 0 when it's free. */
  remainingMs(): Promise<number>;
  /** Frees the lock only if `sessionId` holds it; false (and no change) otherwise. */
  release(sessionId: string): Promise<boolean>;
};

export const LOCK_KEY = "lock:active-session";

// Compare-and-delete: a plain DEL could free a lock that expired and was taken by the next session.
const RELEASE_SCRIPT = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end`;

export function createRedisLock(deps: {
  redis: Pick<Redis, "set" | "get" | "pttl" | "eval">;
  /** Overridable so integration tests don't touch the dev lock. */
  key?: string;
}): Lock {
  const key = deps.key ?? LOCK_KEY;
  return {
    async acquire(sessionId, ttlMs) {
      return (await deps.redis.set(key, sessionId, "PX", ttlMs, "NX")) === "OK";
    },
    holder: () => deps.redis.get(key),
    async remainingMs() {
      // -2: no key; -1: no TTL (never set by us, but don't report it as free forever).
      const ttl = await deps.redis.pttl(key);
      return ttl > 0 ? ttl : 0;
    },
    async release(sessionId) {
      return (await deps.redis.eval(RELEASE_SCRIPT, 1, key, sessionId)) === 1;
    },
  };
}

/** Unit tests and in-process dev: same semantics, time from the injected clock. */
export function createInMemoryLock(clock: Clock): Lock {
  let current: { sessionId: string; expiresAt: number } | undefined;
  const live = () => {
    if (current && current.expiresAt <= clock.now().getTime()) current = undefined;
    return current;
  };
  return {
    acquire: (sessionId, ttlMs) => {
      if (live()) return Promise.resolve(false);
      current = { sessionId, expiresAt: clock.now().getTime() + ttlMs };
      return Promise.resolve(true);
    },
    holder: () => Promise.resolve(live()?.sessionId ?? null),
    remainingMs: () => {
      const held = live();
      return Promise.resolve(held ? held.expiresAt - clock.now().getTime() : 0);
    },
    release: (sessionId) => {
      if (live()?.sessionId !== sessionId) return Promise.resolve(false);
      current = undefined;
      return Promise.resolve(true);
    },
  };
}
