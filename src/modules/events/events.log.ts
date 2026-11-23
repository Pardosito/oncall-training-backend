import type { Redis } from "ioredis";
import type { Logger } from "../../platform/logger.js";
import { type EventLine, EventLineSchema } from "./events.schemas.js";

/** A session's events: buffered during the session, flushed to S3 at the end (D-20). */
export type EventLog = {
  append(sessionId: string, event: EventLine): Promise<void>;
  /** The last `n` events, oldest first. Lines that don't parse are skipped and logged. */
  recent(sessionId: string, n?: number): Promise<EventLine[]>;
  /** Every buffered event, oldest first (for the flush). */
  all(sessionId: string): Promise<EventLine[]>;
  clear(sessionId: string): Promise<void>;
};

export const DEFAULT_RECENT_EVENTS = 20;
/** ARCHITECTURE §7.2: the buffer outlives any session (max resolve + warmup) with room to flush. */
export const EVENTS_TTL_SECONDS = 2 * 60 * 60;
export const eventsKey = (sessionId: string) => `session:${sessionId}:events`;

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function parseLines(lines: string[], sessionId: string, logger: Logger): EventLine[] {
  const events: EventLine[] = [];
  for (const line of lines) {
    const parsed = EventLineSchema.safeParse(parseJson(line));
    if (parsed.success) events.push(parsed.data);
    else logger.warn({ sessionId, line: line.slice(0, 200) }, "invalid event line; skipped");
  }
  return events;
}

/** `RPUSH session:{id}:events` + `EXPIRE 2h` in one MULTI (BE-071); reads with `LRANGE` (BE-072). */
export function createRedisEventLog(deps: {
  redis: Pick<Redis, "multi" | "lrange" | "del">;
  logger: Logger;
  /** Overridable so integration tests don't touch dev keys. */
  keyFor?: (sessionId: string) => string;
}): EventLog {
  const keyFor = deps.keyFor ?? eventsKey;
  const read = async (sessionId: string, start: number) =>
    parseLines(await deps.redis.lrange(keyFor(sessionId), start, -1), sessionId, deps.logger);
  return {
    async append(sessionId, event) {
      const key = keyFor(sessionId);
      const results = await deps.redis
        .multi()
        .rpush(key, JSON.stringify(event))
        .expire(key, EVENTS_TTL_SECONDS)
        .exec();
      const failed = results?.find(([error]) => error);
      if (!results || failed) throw failed?.[0] ?? new Error("event append aborted");
    },
    recent: (sessionId, n = DEFAULT_RECENT_EVENTS) => read(sessionId, -Math.max(1, n)),
    all: (sessionId) => read(sessionId, 0),
    async clear(sessionId) {
      await deps.redis.del(keyFor(sessionId));
    },
  };
}

/** Unit tests and in-process dev. Stores serialized lines, like Redis, so bad lines can be tested. */
export function createInMemoryEventLog(logger: Logger): EventLog & {
  /** Test helper: push a raw line as if another writer stored it. */
  pushRaw(sessionId: string, line: string): void;
} {
  const lists = new Map<string, string[]>();
  const list = (sessionId: string) => lists.get(sessionId) ?? [];
  return {
    append: (sessionId, event) => {
      lists.set(sessionId, [...list(sessionId), JSON.stringify(event)]);
      return Promise.resolve();
    },
    recent: (sessionId, n = DEFAULT_RECENT_EVENTS) =>
      Promise.resolve(parseLines(list(sessionId).slice(-Math.max(1, n)), sessionId, logger)),
    all: (sessionId) => Promise.resolve(parseLines(list(sessionId), sessionId, logger)),
    clear: (sessionId) => {
      lists.delete(sessionId);
      return Promise.resolve();
    },
    pushRaw: (sessionId, line) => {
      lists.set(sessionId, [...list(sessionId), line]);
    },
  };
}
