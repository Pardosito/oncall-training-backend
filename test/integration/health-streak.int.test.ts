import { ulid } from "ulid";
import { afterAll, describe, expect, it } from "vitest";
import { createRedisHealthStreakStore } from "../../src/modules/dashboard/index.js";
import { createLogger } from "../../src/platform/logger.js";
import { closeRedis, createRedis } from "../../src/platform/redis.js";
import { describeHealthStreakContract } from "../../src/test-support/health-streak.contract.js";
import { REDIS_URL, redisUp } from "../helpers/redis.js";

describe.skipIf(!redisUp)("Redis health streak (docker-compose Redis)", () => {
  const redis = createRedis(REDIS_URL, createLogger({ level: "fatal" }));
  const keyFor = (sessionId: string) => `it:health:${sessionId}`;
  const sessions: string[] = [];
  afterAll(async () => {
    const keys = sessions.flatMap((id) => [keyFor(id), keyFor(`${id}-other`)]);
    if (keys.length) await redis.del(...keys);
    await closeRedis(redis);
  });

  describeHealthStreakContract("redis", () => {
    const sessionId = ulid();
    sessions.push(sessionId);
    return { store: createRedisHealthStreakStore({ redis, keyFor }), sessionId };
  });

  it("sets the 1 h TTL on healthy and unhealthy checks", async () => {
    const sessionId = ulid();
    sessions.push(sessionId);
    const store = createRedisHealthStreakStore({ redis, keyFor });
    await store.record(sessionId, true);
    expect(await redis.ttl(keyFor(sessionId))).toBeGreaterThan(3_500);
    await store.record(sessionId, false);
    expect(await redis.ttl(keyFor(sessionId))).toBeGreaterThan(3_500);
  });
});
