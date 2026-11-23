import type { Redis } from "ioredis";
import type { Logger } from "../../platform/logger.js";
import { type DashboardSnapshot, DashboardSnapshotSchema } from "./dashboard.schemas.js";

/**
 * `dashboard:{id}` (ARCHITECTURE §7.2, BE-097): written by the worker's monitor every 2 s, read by
 * the api on each poll. The 10 s TTL means a stopped monitor leaves no snapshot rather than a
 * frozen one: the api then builds it live (BE-130).
 */
export type SnapshotStore = {
  put(snapshot: DashboardSnapshot): Promise<void>;
  /** The snapshot, or null when it's missing, expired or doesn't parse. */
  get(sessionId: string): Promise<DashboardSnapshot | null>;
  clear(sessionId: string): Promise<void>;
};

export const SNAPSHOT_TTL_SECONDS = 10;
export const snapshotKey = (sessionId: string) => `dashboard:${sessionId}`;

function parse(raw: string | null, sessionId: string, logger: Logger): DashboardSnapshot | null {
  if (raw === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    json = undefined;
  }
  const parsed = DashboardSnapshotSchema.safeParse(json);
  if (parsed.success) return parsed.data;
  logger.warn({ sessionId }, "invalid dashboard snapshot in Redis; treated as missing");
  return null;
}

export function createRedisSnapshotStore(deps: {
  redis: Pick<Redis, "set" | "get" | "del">;
  logger: Logger;
  /** Overridable so integration tests don't touch dev keys. */
  keyFor?: (sessionId: string) => string;
}): SnapshotStore {
  const keyFor = deps.keyFor ?? snapshotKey;
  return {
    async put(snapshot) {
      await deps.redis.set(
        keyFor(snapshot.sessionId),
        JSON.stringify(snapshot),
        "EX",
        SNAPSHOT_TTL_SECONDS,
      );
    },
    async get(sessionId) {
      return parse(await deps.redis.get(keyFor(sessionId)), sessionId, deps.logger);
    },
    async clear(sessionId) {
      await deps.redis.del(keyFor(sessionId));
    },
  };
}

/** Unit tests and in-process dev. No TTL: tests clear it explicitly. Stores raw JSON like Redis. */
export function createInMemorySnapshotStore(logger: Logger): SnapshotStore & {
  putRaw(sessionId: string, raw: string): void;
} {
  const items = new Map<string, string>();
  return {
    put: (snapshot) => {
      items.set(snapshot.sessionId, JSON.stringify(snapshot));
      return Promise.resolve();
    },
    get: (sessionId) => Promise.resolve(parse(items.get(sessionId) ?? null, sessionId, logger)),
    clear: (sessionId) => {
      items.delete(sessionId);
      return Promise.resolve();
    },
    putRaw: (sessionId, raw) => {
      items.set(sessionId, raw);
    },
  };
}
