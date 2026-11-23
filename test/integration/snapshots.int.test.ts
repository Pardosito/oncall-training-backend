import { ulid } from "ulid";
import { afterAll, describe, expect, it } from "vitest";
import {
  createRedisSnapshotStore,
  type DashboardSnapshot,
} from "../../src/modules/dashboard/index.js";
import { createLogger } from "../../src/platform/logger.js";
import { closeRedis, createRedis } from "../../src/platform/redis.js";
import { REDIS_URL, redisUp } from "../helpers/redis.js";

describe.skipIf(!redisUp)("Redis dashboard snapshots (docker-compose Redis)", () => {
  const logger = createLogger({ level: "fatal" });
  const redis = createRedis(REDIS_URL, logger);
  const keyFor = (sessionId: string) => `it:dashboard:${sessionId}`;
  const ids: string[] = [];
  afterAll(async () => {
    if (ids.length) await redis.del(...ids.map(keyFor));
    await closeRedis(redis);
  });
  const store = createRedisSnapshotStore({ redis, logger, keyFor });
  const snapshotFor = (sessionId: string): DashboardSnapshot => ({
    sessionId,
    state: "INCIDENT_ACTIVE",
    generatedAt: "2026-11-19T18:00:42.000Z",
    elapsedSeconds: 22,
    services: [{ name: "orders", desiredReplicas: 0, readyReplicas: 0, health: "down", pods: [] }],
    recentEvents: [
      { ts: "2026-11-19T18:00:20.000Z", type: "FAULT_INJECTED", summary: "Incident started" },
    ],
    availableActions: ["ACKNOWLEDGE", "SCALE_DEPLOYMENT"],
  });

  it("round-trips a snapshot with a 10 s TTL, and clear deletes it", async () => {
    const id = ulid();
    ids.push(id);
    await store.put(snapshotFor(id));
    expect(await store.get(id)).toEqual(snapshotFor(id));
    const ttl = await redis.ttl(keyFor(id));
    expect(ttl).toBeGreaterThan(8);
    expect(ttl).toBeLessThanOrEqual(10);
    await store.clear(id);
    expect(await store.get(id)).toBeNull();
  });

  it("treats a bad shape as missing", async () => {
    const id = ulid();
    ids.push(id);
    await redis.set(keyFor(id), JSON.stringify({ sessionId: id }), "EX", 10);
    expect(await store.get(id)).toBeNull();
    await redis.set(keyFor(id), "not json", "EX", 10);
    expect(await store.get(id)).toBeNull();
  });
});
