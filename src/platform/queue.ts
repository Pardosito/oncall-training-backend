import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";

export type SendOptions = {
  /** FIFO only. */
  groupId?: string;
  /** FIFO only. */
  dedupId?: string;
  /** Standard queues only; SQS caps it at 900. */
  delaySeconds?: number;
};

export type ReceivedMessage = { body: string; receiptHandle: string; receiveCount: number };

/** The SQS operations the app uses. Modules depend on this, never on the SDK (AGENTS §7.5). */
export type MessageQueue = {
  send(queueUrl: string, body: unknown, options?: SendOptions): Promise<void>;
  /** Long poll: `WaitTimeSeconds: 20`, up to 10 messages (CONVENTIONS §7). */
  receive(queueUrl: string, signal?: AbortSignal): Promise<ReceivedMessage[]>;
  delete(queueUrl: string, receiptHandle: string): Promise<void>;
};

export const MAX_DELAY_SECONDS = 900;

export function createSqsQueue(sqs: SQSClient, waitTimeSeconds = 20): MessageQueue {
  return {
    async send(queueUrl, body, options = {}) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(body),
          MessageGroupId: options.groupId,
          MessageDeduplicationId: options.dedupId,
          DelaySeconds:
            options.delaySeconds === undefined
              ? undefined
              : Math.min(Math.max(0, Math.floor(options.delaySeconds)), MAX_DELAY_SECONDS),
        }),
      );
    },

    async receive(queueUrl, signal) {
      const { Messages = [] } = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          WaitTimeSeconds: waitTimeSeconds,
          MaxNumberOfMessages: 10,
          MessageSystemAttributeNames: ["ApproximateReceiveCount"],
        }),
        { abortSignal: signal },
      );
      return Messages.flatMap((m) =>
        m.Body !== undefined && m.ReceiptHandle
          ? [
              {
                body: m.Body,
                receiptHandle: m.ReceiptHandle,
                receiveCount: Number(m.Attributes?.ApproximateReceiveCount ?? 1),
              },
            ]
          : [],
      );
    },

    async delete(queueUrl, receiptHandle) {
      await sqs.send(
        new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }),
      );
    },
  };
}

type Stored = { body: string; receiptHandle: string; visibleAt: number; receiveCount: number };

/**
 * In-memory queue with visibility timeout, delay and FIFO dedup, for unit tests and `dev:local`
 * without LocalStack. Receives return immediately (no long poll) unless `pollMs` is set.
 */
export function createInMemoryQueue(
  options: { visibilityMs?: number; pollMs?: number; now?: () => number } = {},
): MessageQueue & { pending(queueUrl: string): unknown[] } {
  const visibilityMs = options.visibilityMs ?? 60_000;
  const now = options.now ?? Date.now;
  const queues = new Map<string, Stored[]>();
  const dedup = new Set<string>();
  let counter = 0;
  const queue = (url: string) => {
    let q = queues.get(url);
    if (!q) queues.set(url, (q = []));
    return q;
  };

  return {
    pending: (url) => queue(url).map((m) => JSON.parse(m.body) as unknown),

    send(url, body, opts = {}) {
      if (opts.dedupId) {
        const key = `${url}#${opts.dedupId}`;
        if (dedup.has(key)) return Promise.resolve();
        dedup.add(key);
      }
      queue(url).push({
        body: JSON.stringify(body),
        receiptHandle: `rh-${++counter}`,
        visibleAt: now() + Math.min(opts.delaySeconds ?? 0, MAX_DELAY_SECONDS) * 1000,
        receiveCount: 0,
      });
      return Promise.resolve();
    },

    async receive(url, signal) {
      const take = () => {
        const visible = queue(url)
          .filter((m) => m.visibleAt <= now())
          .slice(0, 10);
        for (const m of visible) {
          m.visibleAt = now() + visibilityMs;
          m.receiveCount += 1;
          m.receiptHandle = `rh-${++counter}`;
        }
        return visible.map((m) => ({ ...m }));
      };
      let messages = take();
      if (messages.length === 0 && options.pollMs && !signal?.aborted) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, options.pollMs);
          signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
        });
        messages = take();
      }
      return messages;
    },

    delete(url, receiptHandle) {
      const q = queue(url);
      const index = q.findIndex((m) => m.receiptHandle === receiptHandle);
      if (index >= 0) q.splice(index, 1);
      return Promise.resolve();
    },
  };
}
