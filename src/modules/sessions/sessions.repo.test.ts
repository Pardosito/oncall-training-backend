import { describe, expect, it } from "vitest";
import { describeSessionsRepoContract } from "../../test-support/sessions-repo.contract.js";
import { makeSession } from "../../test-support/sessions.js";
import { fromItem, toItem } from "./sessions.item.js";
import { createInMemorySessionsRepo } from "./sessions.repo.js";

describeSessionsRepoContract("in-memory", createInMemorySessionsRepo);

describe("toItem / fromItem", () => {
  it("round-trips a full session through snake_case", () => {
    const session = makeSession({
      state: "RESOLVED",
      executionArn: "arn:aws:states:us-east-1:1:execution:sm:x",
      faultInjectedAt: "2026-11-05T18:00:20.000Z",
      acknowledgedAt: "2026-11-05T18:00:30.000Z",
      validFixAppliedAt: "2026-11-05T18:01:00.000Z",
      wrongActions: 1,
      actionsCount: 4,
      score: 802,
      ttdSeconds: 10,
      ttrSeconds: 50,
      endedAt: "2026-11-05T18:01:10.000Z",
    });

    const item = toItem(session);

    expect(item).toMatchObject({
      user_id: "user-a",
      session_id: session.sessionId,
      fault_injected_at: "2026-11-05T18:00:20.000Z",
      wrong_actions: 1,
      ttr_seconds: 50,
    });
    expect(Object.keys(item).every((key) => key === key.toLowerCase())).toBe(true);
    expect(fromItem(item)).toEqual(session);
  });

  it("drops task_token and defaults missing counters", () => {
    const item: Record<string, unknown> = { ...toItem(makeSession()), task_token: "secret" };
    delete item.wrong_actions;
    delete item.actions_count;
    const session = fromItem(item);
    expect(session).not.toHaveProperty("taskToken");
    expect(JSON.stringify(session)).not.toContain("secret");
    expect(session).toMatchObject({ wrongActions: 0, actionsCount: 0 });
  });

  it("rejects an item with an unknown state", () => {
    expect(() => fromItem({ ...toItem(makeSession()), state: "PAUSED" })).toThrow();
  });
});
