import { GetObjectCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../../platform/logger.js";
import { ordersDownScenario } from "../../test-support/scenarios.js";
import {
  createS3ScenariosRepo,
  createStaticScenariosRepo,
  parseScenarioFiles,
} from "./scenarios.repo.js";

const logger = createLogger({ level: "silent" });
const ordersDown = ordersDownScenario();
const valid = JSON.stringify(ordersDown);

describe("parseScenarioFiles", () => {
  it("keeps valid files sorted by id and skips invalid ones", () => {
    const warn = vi.spyOn(logger, "warn");
    const other = JSON.stringify({ ...ordersDown, id: "a-first" });

    const scenarios = parseScenarioFiles(
      [
        { key: "scenarios/orders-down.json", body: valid },
        { key: "scenarios/broken.json", body: "{not json" },
        { key: "scenarios/bad.json", body: JSON.stringify({ ...ordersDown, targets: [] }) },
        { key: "scenarios/dup.json", body: valid },
        { key: "scenarios/a.json", body: other },
      ],
      logger,
    );

    expect(scenarios.map((s) => s.id)).toEqual(["a-first", "orders-down"]);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("rejects a baseline with zero replicas", () => {
    const body = JSON.stringify({ ...ordersDown, baseline: { ...ordersDown.baseline, orders: 0 } });
    expect(parseScenarioFiles([{ key: "k", body }], logger)).toEqual([]);
  });
});

function fakeS3(objects: Record<string, string>) {
  const send = vi.fn((command: unknown): Promise<unknown> => {
    if (command instanceof ListObjectsV2Command) {
      return Promise.resolve({
        Contents: [...Object.keys(objects), "scenarios/README.md"].map((Key) => ({ Key })),
        IsTruncated: false,
      });
    }
    if (command instanceof GetObjectCommand) {
      const body = objects[command.input.Key ?? ""] ?? "";
      return Promise.resolve({ Body: { transformToString: () => Promise.resolve(body) } });
    }
    return Promise.reject(new Error("unexpected command"));
  });
  return { client: { send } as unknown as S3Client, send };
}

describe("createS3ScenariosRepo", () => {
  it("loads scenarios/*.json once and serves them from memory", async () => {
    const s3 = fakeS3({ "scenarios/orders-down.json": valid });
    const repo = createS3ScenariosRepo({ s3: s3.client, bucket: "b", logger });

    expect((await repo.list()).map((s) => s.id)).toEqual(["orders-down"]);
    expect((await repo.get("orders-down"))?.validFixes).toEqual(ordersDown.validFixes);
    expect(await repo.get("missing")).toBeUndefined();
    expect(s3.send).toHaveBeenCalledTimes(2); // one list + one get
  });

  it("reloads after the ttl", async () => {
    let clock = 0;
    const s3 = fakeS3({ "scenarios/orders-down.json": valid });
    const repo = createS3ScenariosRepo({
      s3: s3.client,
      bucket: "b",
      logger,
      ttlMs: 1000,
      now: () => clock,
    });

    await repo.list();
    clock = 500;
    await repo.list();
    clock = 1500;
    await repo.list();

    expect(s3.send).toHaveBeenCalledTimes(4);
  });

  it("does not cache a failed load", async () => {
    const s3 = fakeS3({ "scenarios/orders-down.json": valid });
    s3.send.mockImplementationOnce(() => Promise.reject(new Error("S3 down")));
    const repo = createS3ScenariosRepo({ s3: s3.client, bucket: "b", logger });

    await expect(repo.list()).rejects.toThrow("S3 down");
    expect(await repo.list()).toHaveLength(1);
  });
});

describe("createStaticScenariosRepo", () => {
  it("serves the given scenarios", async () => {
    const repo = createStaticScenariosRepo([ordersDown]);
    expect(await repo.get("orders-down")).toEqual(ordersDown);
    expect(await repo.list()).toHaveLength(1);
  });
});
