import { beforeEach, describe, expect, it } from "vitest";
import { buildEvent, type EventLog } from "../modules/events/index.js";

export const eventFor = (sessionId: string, i: number) =>
  buildEvent({
    ts: new Date(Date.UTC(2026, 10, 19, 18, 0, i)),
    userId: "user-1",
    sessionId,
    scenarioId: "orders-down",
    type: i === 0 ? "SESSION_STARTED" : "ACTION",
    ...(i === 0 ? {} : { action: "RESTART_DEPLOYMENT", target: "orders", valid: false }),
  });

/**
 * Shared behavior of every `EventLog` (BE-071/072): the in-memory fake in unit tests and Redis
 * in `test/integration`. `pushRaw` stores a line as-is, to test that bad lines are skipped.
 */
export function describeEventLogContract(
  name: string,
  setup: () =>
    | Promise<{ log: EventLog; sessionId: string; pushRaw: (line: string) => Promise<void> }>
    | { log: EventLog; sessionId: string; pushRaw: (line: string) => Promise<void> },
): void {
  describe(`EventLog contract (${name})`, () => {
    let log: EventLog;
    let sessionId: string;
    let pushRaw: (line: string) => Promise<void>;
    beforeEach(async () => {
      ({ log, sessionId, pushRaw } = await setup());
    });

    it("starts empty", async () => {
      expect(await log.all(sessionId)).toEqual([]);
      expect(await log.recent(sessionId)).toEqual([]);
    });

    it("keeps events in append order", async () => {
      for (let i = 0; i < 3; i++) await log.append(sessionId, eventFor(sessionId, i));
      expect(await log.all(sessionId)).toEqual([0, 1, 2].map((i) => eventFor(sessionId, i)));
    });

    it("returns the last n events, oldest first", async () => {
      for (let i = 0; i < 25; i++) await log.append(sessionId, eventFor(sessionId, i));
      const recent = await log.recent(sessionId);
      expect(recent).toHaveLength(20);
      expect(recent[0]).toEqual(eventFor(sessionId, 5));
      expect(recent[19]).toEqual(eventFor(sessionId, 24));
      expect(await log.recent(sessionId, 2)).toEqual([23, 24].map((i) => eventFor(sessionId, i)));
    });

    it("skips lines that aren't valid events", async () => {
      await log.append(sessionId, eventFor(sessionId, 0));
      await pushRaw("not json");
      await pushRaw(JSON.stringify({ type: "ACTION" }));
      await log.append(sessionId, eventFor(sessionId, 1));
      expect(await log.all(sessionId)).toEqual([0, 1].map((i) => eventFor(sessionId, i)));
    });

    it("clears the buffer", async () => {
      await log.append(sessionId, eventFor(sessionId, 0));
      await log.clear(sessionId);
      expect(await log.all(sessionId)).toEqual([]);
    });
  });
}
