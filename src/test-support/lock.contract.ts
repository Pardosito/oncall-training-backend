import { beforeEach, describe, expect, it } from "vitest";
import type { Lock } from "../platform/lock.js";

/**
 * Shared behavior of every `Lock` (BE-064): the in-memory fake in unit tests and Redis in
 * `test/integration`. `advance` moves time: a fixed clock in memory, a real sleep against Redis.
 */
export function describeLockContract(
  name: string,
  setup: () =>
    | Promise<{ lock: Lock; advance: (ms: number) => Promise<void> }>
    | {
        lock: Lock;
        advance: (ms: number) => Promise<void>;
      },
): void {
  describe(`Lock contract (${name})`, () => {
    let lock: Lock;
    let advance: (ms: number) => Promise<void>;
    beforeEach(async () => {
      ({ lock, advance } = await setup());
    });

    it("is free at first", async () => {
      expect(await lock.holder()).toBeNull();
      expect(await lock.remainingMs()).toBe(0);
    });

    it("lets one session in; a second acquire fails while it's held", async () => {
      expect(await lock.acquire("s-1", 5_000)).toBe(true);
      expect(await lock.acquire("s-2", 5_000)).toBe(false);
      expect(await lock.acquire("s-1", 5_000)).toBe(false);
      expect(await lock.holder()).toBe("s-1");
    });

    it("reports the remaining TTL", async () => {
      await lock.acquire("s-1", 5_000);
      const remaining = await lock.remainingMs();
      expect(remaining).toBeGreaterThan(4_000);
      expect(remaining).toBeLessThanOrEqual(5_000);
    });

    it("ignores a release by a session that doesn't hold it", async () => {
      await lock.acquire("s-1", 5_000);
      expect(await lock.release("s-2")).toBe(false);
      expect(await lock.holder()).toBe("s-1");
    });

    it("frees the lock on release by the holder, once", async () => {
      await lock.acquire("s-1", 5_000);
      expect(await lock.release("s-1")).toBe(true);
      expect(await lock.release("s-1")).toBe(false);
      expect(await lock.holder()).toBeNull();
      expect(await lock.acquire("s-2", 5_000)).toBe(true);
    });

    it("keeps the owner next to the holder, and drops it on release", async () => {
      expect(await lock.current()).toBeNull();
      await lock.acquire("s-1", 5_000, "user-1");
      expect(await lock.current()).toEqual({ sessionId: "s-1", userId: "user-1" });
      expect(await lock.acquire("s-2", 5_000, "user-2")).toBe(false);
      expect(await lock.current()).toEqual({ sessionId: "s-1", userId: "user-1" });
      await lock.release("s-1");
      expect(await lock.current()).toBeNull();
      await lock.acquire("s-3", 5_000);
      expect(await lock.current()).toEqual({ sessionId: "s-3" });
    });

    it("frees itself when the TTL expires, and the old holder can't release the new one", async () => {
      await lock.acquire("s-1", 150, "user-1");
      await advance(300);
      expect(await lock.holder()).toBeNull();
      expect(await lock.current()).toBeNull();
      expect(await lock.acquire("s-2", 5_000, "user-2")).toBe(true);
      expect(await lock.release("s-1")).toBe(false);
      expect(await lock.current()).toEqual({ sessionId: "s-2", userId: "user-2" });
    });
  });
}
