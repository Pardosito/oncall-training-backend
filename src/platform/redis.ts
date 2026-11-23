import { Redis } from "ioredis";
import type { ReadinessCheck } from "./http/health.js";
import type { Logger } from "./logger.js";

/**
 * One client per process (BE-023). `rediss://` turns on TLS (ElastiCache, infra D-09: TLS, no
 * AUTH token). Commands fail fast while Redis is down instead of queueing for minutes, and
 * connection errors are logged (ioredis keeps reconnecting) rather than crashing the process.
 */
export function createRedis(url: string, logger: Logger): Redis {
  const redis = new Redis(url, {
    ...(url.startsWith("rediss://") ? { tls: {} } : {}),
    connectTimeout: 5_000,
    maxRetriesPerRequest: 2,
    // Without it, ioredis rejects commands sent before the first connect completes.
    enableOfflineQueue: true,
  });
  let lastLogged = 0;
  redis.on("error", (error: Error) => {
    // ioredis emits an error per reconnect attempt; one line every 10 s is enough.
    if (Date.now() - lastLogged < 10_000) return;
    lastLogged = Date.now();
    logger.warn({ err: error }, "redis connection error");
  });
  return redis;
}

/** For shutdown: QUIT lets pending replies arrive; a dead connection is just dropped. */
export async function closeRedis(redis: Redis): Promise<void> {
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}

/** `/readyz` check (BE-024): `PING`, bounded by the readiness timeout. */
export function createRedisReadinessCheck(redis: Pick<Redis, "ping">): ReadinessCheck {
  return {
    name: "redis",
    check: (signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(new Error("aborted"));
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        redis.ping().then(() => resolve(), reject);
      }),
  };
}
