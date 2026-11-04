import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../platform/logger.js";
import { createInMemoryQueue, type MessageQueue } from "../platform/queue.js";
import { type QueueMessage, QueueMessageSchema } from "../modules/actions/index.js";
import { runConsumer } from "./consumer.js";

const URL = "user-actions.fifo";
const logger = createLogger({ level: "silent" });
const ack = {
  kind: "USER",
  type: "ACKNOWLEDGE",
  actionId: "01JC0000000000000000000001",
  sessionId: "01JC0000000000000000000002",
  userId: "u",
  requestedAt: "2026-11-05T18:00:00.000Z",
};

/** Runs the consumer until the queue has been polled `polls` times. */
async function drain(queue: MessageQueue, handle: (m: QueueMessage) => Promise<void>, polls = 2) {
  const controller = new AbortController();
  let count = 0;
  const counting: MessageQueue = {
    ...queue,
    receive: async (url, signal) => {
      if (++count > polls) controller.abort();
      return queue.receive(url, signal);
    },
  };
  await runConsumer({
    queue: counting,
    queueUrl: URL,
    parse: (body) => QueueMessageSchema.parse(body),
    handle,
    logger,
    signal: controller.signal,
    backoffMs: 1,
  });
}

describe("runConsumer", () => {
  it("handles valid messages in order and deletes them", async () => {
    const queue = createInMemoryQueue();
    await queue.send(URL, ack);
    await queue.send(URL, { ...ack, actionId: "01JC0000000000000000000003" });
    const seen: string[] = [];
    const handle = (m: QueueMessage) => {
      if (m.kind === "USER") seen.push(m.actionId);
      return Promise.resolve();
    };

    await drain(queue, handle);

    expect(seen).toEqual(["01JC0000000000000000000001", "01JC0000000000000000000003"]);
    expect(queue.pending(URL)).toEqual([]);
  });

  it("leaves invalid messages and failed handlers on the queue, and keeps going", async () => {
    const queue = createInMemoryQueue();
    await queue.send(URL, { kind: "SYSTEM", type: "SESSION_ENDED" });
    await queue.send(URL, ack);
    await queue.send(URL, { ...ack, actionId: "01JC0000000000000000000003" });
    const handle = vi
      .fn<(m: QueueMessage) => Promise<void>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue();

    await drain(queue, handle);

    expect(handle).toHaveBeenCalledTimes(2);
    expect(queue.pending(URL)).toHaveLength(2);
  });

  it("backs off and retries after a receive error", async () => {
    const queue = createInMemoryQueue();
    await queue.send(URL, ack);
    const flaky: MessageQueue = {
      ...queue,
      receive: vi
        .fn<MessageQueue["receive"]>()
        .mockRejectedValueOnce(new Error("throttled"))
        .mockImplementation((url, signal) => queue.receive(url, signal)),
    };
    const handle = vi.fn(() => Promise.resolve());

    await drain(flaky, handle, 3);

    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("stops when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runConsumer({
        queue: createInMemoryQueue(),
        queueUrl: URL,
        parse: (b) => b as QueueMessage,
        handle: () => Promise.resolve(),
        logger,
        signal: controller.signal,
      }),
    ).resolves.toBeUndefined();
  });
});
