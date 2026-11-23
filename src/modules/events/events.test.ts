import { PutObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../../platform/logger.js";
import { describeEventLogContract, eventFor } from "../../test-support/event-log.contract.js";
import {
  buildEvent,
  createEventFlusher,
  createInMemoryEventLog,
  EventLineSchema,
  eventsObjectKey,
  summarizeEvent,
} from "./index.js";

const logger = createLogger({ level: "silent" });
const KEYS = [
  "ts",
  "user_id",
  "session_id",
  "scenario_id",
  "type",
  "action",
  "target",
  "params",
  "valid",
  "score",
  "ttd_seconds",
  "ttr_seconds",
];
const base = {
  ts: "2026-11-19T18:00:00.000Z",
  userId: "user-1",
  sessionId: "s-1",
  scenarioId: "orders-down",
};

describe("buildEvent", () => {
  it("fills every missing key with null", () => {
    expect(buildEvent({ ...base, type: "SESSION_STARTED" })).toEqual({
      ts: "2026-11-19T18:00:00.000Z",
      user_id: "user-1",
      session_id: "s-1",
      scenario_id: "orders-down",
      type: "SESSION_STARTED",
      action: null,
      target: null,
      params: null,
      valid: null,
      score: null,
      ttd_seconds: null,
      ttr_seconds: null,
    });
  });

  it("gives every event type the same key set, in §7.4 order", () => {
    const events = [
      buildEvent({ ...base, type: "SESSION_STARTED" }),
      buildEvent({ ...base, type: "FAULT_INJECTED", target: "orders" }),
      buildEvent({ ...base, type: "ACKNOWLEDGED" }),
      buildEvent({
        ...base,
        type: "ACTION",
        action: "SCALE_DEPLOYMENT",
        target: "orders",
        params: { replicas: 2 },
        valid: true,
      }),
      buildEvent({ ...base, type: "VIEW_LOGS", target: "gateway" }),
      buildEvent({ ...base, type: "RESOLVED", ttdSeconds: 12, ttrSeconds: 40 }),
      buildEvent({ ...base, type: "SCORED", score: 911.6, ttdSeconds: 12, ttrSeconds: 40 }),
      buildEvent({ ...base, type: "FAILED" }),
    ];
    for (const event of events) expect(Object.keys(event)).toEqual(KEYS);
  });

  it("takes a Date, rounds the score to an int (Glue column) and drops extra params", () => {
    const event = buildEvent({
      ...base,
      ts: new Date("2026-11-19T18:00:05Z"),
      type: "ACTION",
      params: { replicas: 3, extra: 1 } as { replicas: number },
      score: 911.6,
    });
    expect(event).toMatchObject({
      ts: "2026-11-19T18:00:05.000Z",
      params: { replicas: 3 },
      score: 912,
    });
  });

  it("rejects an invalid event instead of writing a bad line", () => {
    expect(() => buildEvent({ ...base, ts: "yesterday", type: "ACTION" })).toThrow();
    expect(
      EventLineSchema.safeParse({ ...buildEvent({ ...base, type: "ACTION" }), type: "X" }).success,
    ).toBe(false);
  });
});

describe("summarizeEvent", () => {
  const line = (input: Partial<Parameters<typeof buildEvent>[0]>) =>
    buildEvent({ ...base, type: "ACTION", ...input });

  it.each([
    [line({ type: "SESSION_STARTED" }), "Session started"],
    [line({ type: "FAULT_INJECTED", target: "orders" }), "Incident started"],
    [line({ type: "ACKNOWLEDGED" }), "Incident acknowledged"],
    [line({ type: "VIEW_LOGS", target: "gateway" }), "Viewed logs of gateway"],
    [
      line({ action: "SCALE_DEPLOYMENT", target: "orders", params: { replicas: 2 }, valid: true }),
      "Scaled orders to 2",
    ],
    [
      line({ action: "RESTART_DEPLOYMENT", target: "gateway", valid: false }),
      "Restarted gateway (no effect on the incident)",
    ],
    [line({ action: "SOMETHING_NEW", target: "orders" }), "SOMETHING_NEW orders"],
    [line({ type: "RESOLVED" }), "Incident resolved"],
    [line({ type: "SCORED", score: 880 }), "Scored 880"],
    [line({ type: "FAILED" }), "Session failed"],
  ])("%#: %s", (event, summary) => {
    expect(summarizeEvent(event)).toBe(summary);
  });
});

describe("eventsObjectKey", () => {
  it("uses the session's created_at in UTC, zero-padded", () => {
    expect(eventsObjectKey({ sessionId: "s-1", createdAt: "2026-03-04T23:59:59.000Z" })).toBe(
      "logs/year=2026/month=03/day=04/s-1.ndjson",
    );
    expect(eventsObjectKey({ sessionId: "s-2", createdAt: "2026-11-30T23:30:00.000-06:00" })).toBe(
      "logs/year=2026/month=12/day=01/s-2.ndjson",
    );
  });
});

describeEventLogContract("in memory", () => {
  const log = createInMemoryEventLog(logger);
  return {
    log,
    sessionId: "s-1",
    pushRaw: (line) => {
      log.pushRaw("s-1", line);
      return Promise.resolve();
    },
  };
});

describe("createEventFlusher", () => {
  const session = { sessionId: "s-1", createdAt: "2026-11-19T18:00:00.000Z" };
  const setup = (send = vi.fn().mockResolvedValue({})) => {
    const events = createInMemoryEventLog(logger);
    const flusher = createEventFlusher({ events, s3: { send }, bucket: "files", logger });
    return { events, flusher, send };
  };

  it("writes one event per line as NDJSON and leaves the buffer for the caller to clear", async () => {
    const { events, flusher, send } = setup();
    await events.append("s-1", eventFor("s-1", 0));
    await events.append("s-1", eventFor("s-1", 1));

    expect(await flusher.flush(session)).toEqual({
      key: "logs/year=2026/month=11/day=19/s-1.ndjson",
      count: 2,
    });
    const command = send.mock.calls[0]?.[0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: "files",
      Key: "logs/year=2026/month=11/day=19/s-1.ndjson",
      ContentType: "application/x-ndjson",
    });
    const lines = (command.input.Body as string).trimEnd().split("\n");
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([
      eventFor("s-1", 0),
      eventFor("s-1", 1),
    ]);
    expect(await events.all("s-1")).toHaveLength(2);
  });

  it("writes nothing for an empty buffer", async () => {
    const { flusher, send } = setup();
    expect(await flusher.flush(session)).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("throws when the upload fails and keeps the buffer", async () => {
    const { events, flusher } = setup(vi.fn().mockRejectedValue(new Error("s3 down")));
    await events.append("s-1", eventFor("s-1", 0));
    await expect(flusher.flush(session)).rejects.toThrow("s3 down");
    expect(await events.all("s-1")).toHaveLength(1);
  });
});
