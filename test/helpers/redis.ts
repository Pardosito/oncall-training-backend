import { Redis } from "ioredis";

/** Same URL as `.env.example` (docker-compose's Redis). */
export const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

async function redisAvailable(): Promise<boolean> {
  const probe = new Redis(REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 1000,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  probe.on("error", () => undefined);
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

/** `describe.skipIf(!redisUp)` with one clear message, like the LocalStack helper. */
export const redisUp = await redisAvailable();
if (!redisUp) {
  process.stderr.write(
    `\nRedis is not reachable at ${REDIS_URL}: run \`docker compose up -d\`. Skipping.\n`,
  );
}
