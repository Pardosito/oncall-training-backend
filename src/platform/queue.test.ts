import { describe, expect, it } from "vitest";
import { createInMemoryQueue } from "./queue.js";

describe("createInMemoryQueue", () => {
  it("delivers, hides until the visibility timeout, and deletes", async () => {
    let clock = 0;
    const queue = createInMemoryQueue({ visibilityMs: 1000, now: () => clock });
    await queue.send("q", { n: 1 });

    const [first] = await queue.receive("q");
    expect(JSON.parse(first?.body ?? "")).toEqual({ n: 1 });
    expect(await queue.receive("q")).toEqual([]);

    clock = 1500;
    const [again] = await queue.receive("q");
    expect(again?.receiveCount).toBe(2);

    await queue.delete("q", again?.receiptHandle ?? "");
    clock = 5000;
    expect(await queue.receive("q")).toEqual([]);
  });

  it("honors the delay and drops FIFO duplicates", async () => {
    let clock = 0;
    const queue = createInMemoryQueue({ now: () => clock });
    await queue.send("q", { n: 1 }, { delaySeconds: 20 });
    await queue.send("f", { n: 2 }, { groupId: "s", dedupId: "a" });
    await queue.send("f", { n: 2 }, { groupId: "s", dedupId: "a" });

    expect(await queue.receive("q")).toEqual([]);
    clock = 20_000;
    expect(await queue.receive("q")).toHaveLength(1);
    expect(queue.pending("f")).toHaveLength(1);
  });

  it("stops waiting when aborted", async () => {
    const queue = createInMemoryQueue({ pollMs: 10_000 });
    const controller = new AbortController();
    const pending = queue.receive("q", controller.signal);
    controller.abort();
    expect(await pending).toEqual([]);
  });
});
