import { beforeEach, describe, expect, it } from "vitest";
import type { HealthStreakStore } from "../modules/dashboard/index.js";

/** Shared behavior of every `HealthStreakStore` (BE-099): in memory and in Redis. */
export function describeHealthStreakContract(
  name: string,
  setup: () => { store: HealthStreakStore; sessionId: string },
): void {
  describe(`HealthStreakStore contract (${name})`, () => {
    let store: HealthStreakStore;
    let sessionId: string;
    beforeEach(() => {
      ({ store, sessionId } = setup());
    });

    it("counts consecutive healthy checks", async () => {
      expect(await store.record(sessionId, true)).toBe(1);
      expect(await store.record(sessionId, true)).toBe(2);
      expect(await store.record(sessionId, true)).toBe(3);
    });

    it("resets on an unhealthy check (flapping never reaches 2)", async () => {
      expect(await store.record(sessionId, true)).toBe(1);
      expect(await store.record(sessionId, false)).toBe(0);
      expect(await store.record(sessionId, true)).toBe(1);
      expect(await store.record(sessionId, false)).toBe(0);
    });

    it("starts over after clear, per session", async () => {
      await store.record(sessionId, true);
      await store.record(`${sessionId}-other`, true);
      await store.clear(sessionId);
      expect(await store.record(sessionId, true)).toBe(1);
      expect(await store.record(`${sessionId}-other`, true)).toBe(2);
      await store.clear(`${sessionId}-other`);
    });
  });
}
