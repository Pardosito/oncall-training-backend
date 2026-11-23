import { GetObjectCommand } from "@aws-sdk/client-s3";
import { ulid } from "ulid";
import { afterAll, describe, expect, it } from "vitest";
import { createEventFlusher, createRedisEventLog } from "../../src/modules/events/index.js";
import { createLogger } from "../../src/platform/logger.js";
import { closeRedis, createRedis } from "../../src/platform/redis.js";
import { describeEventLogContract, eventFor } from "../../src/test-support/event-log.contract.js";
import { available, BUCKET, destroyAwsClients, localClients } from "../helpers/localstack.js";
import { REDIS_URL, redisUp } from "../helpers/redis.js";

const logger = createLogger({ level: "fatal" });

describe.skipIf(!redisUp)("Redis event log (docker-compose Redis)", () => {
  const redis = createRedis(REDIS_URL, logger);
  const keys: string[] = [];
  // A fresh key per test, so dev sessions' buffers are never touched.
  const keyFor = (sessionId: string) => {
    const key = `it:events:${sessionId}`;
    keys.push(key);
    return key;
  };
  afterAll(async () => {
    if (keys.length) await redis.del(...keys);
    await closeRedis(redis);
  });

  describeEventLogContract("redis", () => {
    const sessionId = ulid();
    return {
      log: createRedisEventLog({ redis, logger, keyFor }),
      sessionId,
      pushRaw: async (line) => {
        await redis.rpush(keyFor(sessionId), line);
      },
    };
  });

  it("sets the 2 h TTL on append", async () => {
    const sessionId = ulid();
    await createRedisEventLog({ redis, logger, keyFor }).append(sessionId, eventFor(sessionId, 0));
    const ttl = await redis.ttl(keyFor(sessionId));
    expect(ttl).toBeGreaterThan(7_000);
    expect(ttl).toBeLessThanOrEqual(7_200);
  });

  describe.skipIf(!available)("flush to LocalStack S3", () => {
    const aws = localClients();
    afterAll(() => destroyAwsClients(aws));

    it("uploads NDJSON under the partitioned key, overwrites on re-flush, then clears Redis", async () => {
      const sessionId = ulid();
      const events = createRedisEventLog({ redis, logger, keyFor });
      const flusher = createEventFlusher({ events, s3: aws.s3, bucket: BUCKET, logger });
      const session = { sessionId, createdAt: "2026-11-19T18:00:00.000Z" };

      await events.append(sessionId, eventFor(sessionId, 0));
      await events.append(sessionId, eventFor(sessionId, 1));
      const first = await flusher.flush(session);
      expect(first).toEqual({
        key: `logs/year=2026/month=11/day=19/${sessionId}.ndjson`,
        count: 2,
      });
      expect(await redis.exists(keyFor(sessionId))).toBe(0);
      expect(await flusher.flush(session)).toBeNull();

      // A redelivered SESSION_ENDED after new events: same key, overwritten.
      await events.append(sessionId, eventFor(sessionId, 2));
      await flusher.flush(session);
      const object = await aws.s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: first?.key }));
      expect(object.ContentType).toBe("application/x-ndjson");
      const body = (await object.Body?.transformToString()) ?? "";
      expect(
        body
          .trimEnd()
          .split("\n")
          .map((l) => JSON.parse(l) as unknown),
      ).toEqual([eventFor(sessionId, 2)]);
    });
  });
});
