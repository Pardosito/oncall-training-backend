import { describe, expect, it } from "vitest";
import { ActionRequestSchema, QueueMessageSchema } from "./actions.schemas.js";

const ids = {
  actionId: "01JBQ4ZJ8V2N7K3M5P6R8S9T0W",
  sessionId: "01JBQ4ZJ8V2N7K3M5P6R8S9T0X",
  userId: "user-1",
};

describe("ActionRequestSchema", () => {
  it.each([
    { type: "ACKNOWLEDGE" },
    { type: "RESTART_DEPLOYMENT", target: "orders" },
    { type: "SCALE_DEPLOYMENT", target: "orders", params: { replicas: 2 } },
  ])("accepts $type", (body) => {
    expect(ActionRequestSchema.safeParse(body).success).toBe(true);
  });

  it.each([0, 4, 1.5, undefined])("rejects SCALE_DEPLOYMENT with replicas %s", (replicas) => {
    const body = { type: "SCALE_DEPLOYMENT", target: "orders", params: { replicas } };
    expect(ActionRequestSchema.safeParse(body).success).toBe(false);
  });

  it("rejects RESTART_DEPLOYMENT without a target", () => {
    expect(ActionRequestSchema.safeParse({ type: "RESTART_DEPLOYMENT" }).success).toBe(false);
  });

  it.each(["SESSION_ENDED", "ABANDON", "VIEW_LOGS", "AWAIT_FIX", "ROLLBACK"])(
    "never accepts %s from HTTP",
    (type) => {
      expect(ActionRequestSchema.safeParse({ type, target: "orders" }).success).toBe(false);
    },
  );
});

describe("QueueMessageSchema", () => {
  const requestedAt = "2026-11-05T18:01:00.000Z";

  it("parses a USER scale action (§8.5)", () => {
    const message = {
      kind: "USER",
      ...ids,
      type: "SCALE_DEPLOYMENT",
      target: "orders",
      params: { replicas: 2 },
      requestedAt,
    };
    expect(QueueMessageSchema.parse(message)).toEqual(message);
  });

  it("parses a USER ABANDON", () => {
    expect(
      QueueMessageSchema.safeParse({ kind: "USER", ...ids, type: "ABANDON", requestedAt }).success,
    ).toBe(true);
  });

  it("parses SESSION_ENDED with and without a reason (§8.4)", () => {
    const base = { kind: "SYSTEM", type: "SESSION_ENDED", sessionId: ids.sessionId, userId: "u" };
    expect(
      QueueMessageSchema.safeParse({ ...base, outcome: "RESOLVED", reason: null }).success,
    ).toBe(true);
    expect(
      QueueMessageSchema.safeParse({ ...base, outcome: "FAILED", reason: "TIMEOUT" }).success,
    ).toBe(true);
  });

  it("parses AWAIT_FIX (infra §7, M2)", () => {
    const message = {
      kind: "SYSTEM",
      type: "AWAIT_FIX",
      sessionId: ids.sessionId,
      userId: "u",
      taskToken: "token",
    };
    expect(QueueMessageSchema.safeParse(message).success).toBe(true);
  });

  it.each([
    [
      "a USER message without userId",
      { kind: "USER", ...ids, userId: undefined, type: "ACKNOWLEDGE", requestedAt },
    ],
    [
      "a USER scale without params",
      { kind: "USER", ...ids, type: "SCALE_DEPLOYMENT", target: "orders", requestedAt },
    ],
    ["SESSION_ENDED sent as USER", { kind: "USER", ...ids, type: "SESSION_ENDED", requestedAt }],
    ["an unknown kind", { kind: "ADMIN", ...ids, type: "ACKNOWLEDGE", requestedAt }],
    [
      "a bad outcome",
      {
        kind: "SYSTEM",
        type: "SESSION_ENDED",
        sessionId: ids.sessionId,
        userId: "u",
        outcome: "DONE",
        reason: null,
      },
    ],
    ["a non-JSON-object", "SCALE orders 2"],
  ])("rejects %s", (_name, message) => {
    expect(QueueMessageSchema.safeParse(message).success).toBe(false);
  });
});
