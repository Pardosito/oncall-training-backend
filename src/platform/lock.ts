import type { Redis } from "ioredis";
import type { Clock } from "./clock.js";

/**
 * The global session lock (D-05, ARCHITECTURE §4.2 steps 1 and 7.4, §7.2): one active session
 * at a time, held by its sessionId with a TTL as the last resort if nobody releases it.
 */
export type Lock = {
  /**
   * Takes the lock for `sessionId` if it's free. `userId` is stored next to it (same TTL), so
   * the worker's monitor can read the session item without a scan (BE-100).
   */
  acquire(sessionId: string, ttlMs: number, userId?: string): Promise<boolean>;
  /** The sessionId holding the lock, or null. */
  holder(): Promise<string | null>;
  /** The holder and its owner; `userId` is absent if the lock was taken without one. */
  current(): Promise<{ sessionId: string; userId?: string } | null>;
  /** Milliseconds until the lock expires; 0 when it's free. */
  remainingMs(): Promise<number>;
  /** Frees the lock only if `sessionId` holds it; false (and no change) otherwise. */
  release(sessionId: string): Promise<boolean>;
};

export const LOCK_KEY = "lock:active-session";
export const ownerKey = (key: string) => `${key}:owner`;

// SET NX on the lock and, only if that won, the owner with the same TTL: atomic, so the owner key
// never belongs to another session than the lock.
const ACQUIRE_SCRIPT = `if redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2], "NX") then
  if ARGV[3] ~= "" then redis.call("SET", KEYS[2], ARGV[3], "PX", ARGV[2]) else redis.call("DEL", KEYS[2]) end
  return 1
end
return 0`;
// Compare-and-delete: a plain DEL could free a lock that expired and was taken by the next session.
const RELEASE_SCRIPT = `if redis.call("GET", KEYS[1]) == ARGV[1] then
  redis.call("DEL", KEYS[2])
  return redis.call("DEL", KEYS[1])
end
return 0`;

export function createRedisLock(deps: {
  redis: Pick<Redis, "get" | "mget" | "pttl" | "eval">;
  /** Overridable so integration tests don't touch the dev lock. */
  key?: string;
}): Lock {
  const key = deps.key ?? LOCK_KEY;
  const owner = ownerKey(key);
  return {
    async acquire(sessionId, ttlMs, userId) {
      const won = await deps.redis.eval(
        ACQUIRE_SCRIPT,
        2,
        key,
        owner,
        sessionId,
        String(ttlMs),
        userId ?? "",
      );
      return won === 1;
    },
    holder: () => deps.redis.get(key),
    async current() {
      const [sessionId, userId] = await deps.redis.mget(key, owner);
      if (!sessionId) return null;
      return userId ? { sessionId, userId } : { sessionId };
    },
    async remainingMs() {
      // -2: no key; -1: no TTL (never set by us, but don't report it as free forever).
      const ttl = await deps.redis.pttl(key);
      return ttl > 0 ? ttl : 0;
    },
    async release(sessionId) {
      return (await deps.redis.eval(RELEASE_SCRIPT, 2, key, owner, sessionId)) === 1;
    },
  };
}

/** Unit tests and in-process dev: same semantics, time from the injected clock. */
export function createInMemoryLock(clock: Clock): Lock {
  let current: { sessionId: string; userId?: string; expiresAt: number } | undefined;
  const live = () => {
    if (current && current.expiresAt <= clock.now().getTime()) current = undefined;
    return current;
  };
  return {
    acquire: (sessionId, ttlMs, userId) => {
      if (live()) return Promise.resolve(false);
      current = {
        sessionId,
        ...(userId ? { userId } : {}),
        expiresAt: clock.now().getTime() + ttlMs,
      };
      return Promise.resolve(true);
    },
    holder: () => Promise.resolve(live()?.sessionId ?? null),
    current: () => {
      const held = live();
      if (!held) return Promise.resolve(null);
      return Promise.resolve(
        held.userId
          ? { sessionId: held.sessionId, userId: held.userId }
          : { sessionId: held.sessionId },
      );
    },
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
