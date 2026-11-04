import type { Logger } from "../platform/logger.js";
import type { MessageQueue } from "../platform/queue.js";

/** Pause after a failed receive so a broken queue doesn't spin the loop. */
export const RECEIVE_ERROR_BACKOFF_MS = 5_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });
}

/**
 * Long-polls a queue (`user-actions` in the worker) until `signal` aborts (BE-088, CONVENTIONS §10). Messages of a batch
 * run in order (FIFO per session). A message is deleted only after its handler succeeds; an
 * invalid body or a failing handler is left for SQS to redeliver, and to the DLQ after 3 tries.
 */
export async function runConsumer<T extends { sessionId: string; type: string }>(deps: {
  queue: MessageQueue;
  queueUrl: string;
  /** Validates a parsed body; throwing marks the message invalid. */
  parse: (body: unknown) => T;
  handle: (message: T) => Promise<void>;
  /** Log context, e.g. `consumer` or `fake-injector`. */
  name?: string;
  logger: Logger;
  signal: AbortSignal;
  backoffMs?: number;
}): Promise<void> {
  const log = deps.logger.child({ loop: deps.name ?? "consumer" });
  log.info("consumer started");
  while (!deps.signal.aborted) {
    let batch;
    try {
      batch = await deps.queue.receive(deps.queueUrl, deps.signal);
    } catch (error) {
      if (deps.signal.aborted) break;
      log.error({ err: error }, "receive failed");
      await sleep(deps.backoffMs ?? RECEIVE_ERROR_BACKOFF_MS, deps.signal);
      continue;
    }
    for (const received of batch) {
      let message: T;
      try {
        message = deps.parse(JSON.parse(received.body));
      } catch (error) {
        log.error(
          { err: error, receiveCount: received.receiveCount },
          "invalid queue message; left for the DLQ",
        );
        continue;
      }
      try {
        await deps.handle(message);
        await deps.queue.delete(deps.queueUrl, received.receiptHandle);
      } catch (error) {
        log.error(
          {
            err: error,
            sessionId: message.sessionId,
            type: message.type,
            receiveCount: received.receiveCount,
          },
          "handler failed; message will be retried",
        );
      }
    }
  }
  log.info("consumer stopped");
}
