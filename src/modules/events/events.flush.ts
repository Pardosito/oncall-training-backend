import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { Logger } from "../../platform/logger.js";
import type { EventLog } from "./events.log.js";

/**
 * `logs/year=YYYY/month=MM/day=DD/{sessionId}.ndjson` (ARCHITECTURE §7.3), dated by the session's
 * `created_at` in UTC so the partition matches the Glue projection even for sessions that
 * cross midnight.
 */
export function eventsObjectKey(session: { sessionId: string; createdAt: string }): string {
  const created = new Date(session.createdAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `logs/year=${created.getUTCFullYear()}/month=${pad(created.getUTCMonth() + 1)}` +
    `/day=${pad(created.getUTCDate())}/${session.sessionId}.ndjson`
  );
}

export type EventFlusher = {
  /**
   * Uploads the buffer as NDJSON, then deletes it (BE-073). Idempotent: the key is fixed per
   * session, so a re-flush overwrites the same object. Empty buffer: nothing is written. The
   * buffer is deleted only after a successful upload; an upload error is thrown.
   */
  flush(session: {
    sessionId: string;
    createdAt: string;
  }): Promise<{ key: string; count: number } | null>;
};

export function createEventFlusher(deps: {
  events: EventLog;
  s3: Pick<S3Client, "send">;
  bucket: string;
  logger: Logger;
}): EventFlusher {
  return {
    async flush(session) {
      const events = await deps.events.all(session.sessionId);
      if (events.length === 0) return null;
      const key = eventsObjectKey(session);
      await deps.s3.send(
        new PutObjectCommand({
          Bucket: deps.bucket,
          Key: key,
          Body: events.map((event) => JSON.stringify(event)).join("\n") + "\n",
          ContentType: "application/x-ndjson",
        }),
      );
      await deps.events.clear(session.sessionId);
      deps.logger.info(
        { sessionId: session.sessionId, key, count: events.length },
        "events flushed",
      );
      return { key, count: events.length };
    },
  };
}
