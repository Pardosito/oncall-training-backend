import { ulid } from "ulid";
import { afterAll, describe } from "vitest";
import { createRedisLock } from "../../src/platform/lock.js";
import { closeRedis, createRedis } from "../../src/platform/redis.js";
import { createLogger } from "../../src/platform/logger.js";
import { describeLockContract } from "../../src/test-support/lock.contract.js";
import { REDIS_URL, redisUp } from "../helpers/redis.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.skipIf(!redisUp)("Redis lock (docker-compose Redis)", () => {
  const redis = createRedis(REDIS_URL, createLogger({ level: "fatal" }));
  const keys: string[] = [];
  afterAll(async () => {
    if (keys.length) await redis.del(...keys);
    await closeRedis(redis);
  });

  // A fresh key per test, so the dev lock (lock:active-session) is never touched.
  describeLockContract("redis", () => {
    const key = `it:lock:${ulid()}`;
    keys.push(key);
    return { lock: createRedisLock({ redis, key }), advance: sleep };
  });
});
