import { GetObjectCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import type { Logger } from "../../platform/logger.js";
import { type Scenario, ScenarioSchema } from "./scenarios.schemas.js";

export const SCENARIOS_PREFIX = "scenarios/";

/** Read-only scenario catalog, cached in memory (ARCHITECTURE §7.3, BE-048). */
export type ScenariosRepo = {
  list(): Promise<Scenario[]>;
  get(id: string): Promise<Scenario | undefined>;
};

/** Parses raw scenario files; invalid ones are logged and skipped so one bad file can't take the API down. */
export function parseScenarioFiles(
  files: { key: string; body: string }[],
  logger: Logger,
): Scenario[] {
  const scenarios = new Map<string, Scenario>();
  for (const { key, body } of files) {
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      logger.warn({ key }, "scenario file is not valid JSON; skipped");
      continue;
    }
    const parsed = ScenarioSchema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      logger.warn({ key, issues }, "scenario file is invalid; skipped");
      continue;
    }
    if (scenarios.has(parsed.data.id)) {
      logger.warn({ key, scenarioId: parsed.data.id }, "duplicate scenario id; skipped");
      continue;
    }
    scenarios.set(parsed.data.id, parsed.data);
  }
  return [...scenarios.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Loads every `scenarios/*.json` from S3 once and keeps it for `ttlMs` (default: forever). */
export function createS3ScenariosRepo(deps: {
  s3: S3Client;
  bucket: string;
  logger: Logger;
  ttlMs?: number;
  now?: () => number;
}): ScenariosRepo {
  const now = deps.now ?? Date.now;
  let cache: { at: number; scenarios: Promise<Scenario[]> } | undefined;

  async function load(): Promise<Scenario[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await deps.s3.send(
        new ListObjectsV2Command({
          Bucket: deps.bucket,
          Prefix: SCENARIOS_PREFIX,
          ContinuationToken: token,
        }),
      );
      for (const object of page.Contents ?? []) {
        if (object.Key?.endsWith(".json")) keys.push(object.Key);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);

    const files = await Promise.all(
      keys.map(async (key) => {
        const object = await deps.s3.send(new GetObjectCommand({ Bucket: deps.bucket, Key: key }));
        return { key, body: (await object.Body?.transformToString()) ?? "" };
      }),
    );
    const scenarios = parseScenarioFiles(files, deps.logger);
    deps.logger.info({ count: scenarios.length }, "scenarios loaded");
    return scenarios;
  }

  function scenarios(): Promise<Scenario[]> {
    const expired = cache && deps.ttlMs !== undefined && now() - cache.at > deps.ttlMs;
    if (!cache || expired) {
      const pending = load();
      cache = { at: now(), scenarios: pending };
      // A failed load is not cached: the next request retries.
      pending.catch(() => {
        if (cache?.scenarios === pending) cache = undefined;
      });
    }
    return cache.scenarios;
  }

  return {
    list: () => scenarios(),
    get: async (id) => (await scenarios()).find((s) => s.id === id),
  };
}

/** In-memory catalog for tests and `dev:local`. */
export function createStaticScenariosRepo(scenarios: Scenario[]): ScenariosRepo {
  const byId = new Map(scenarios.map((s) => [s.id, ScenarioSchema.parse(s)]));
  return {
    list: () => Promise.resolve([...byId.values()]),
    get: (id) => Promise.resolve(byId.get(id)),
  };
}
