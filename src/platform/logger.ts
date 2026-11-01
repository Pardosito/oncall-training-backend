import { type DestinationStream, type Logger, pino } from "pino";

export type { Logger } from "pino";

/** Paths never written to the logs (CONVENTIONS §11). */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "taskToken",
  "task_token",
  "*.taskToken",
  "*.task_token",
];

export type LoggerOptions = {
  level: string;
  /** Pretty output through pino-pretty (a dev dependency); only for local development. */
  pretty?: boolean;
  destination?: DestinationStream;
};

export function createLogger({ level, pretty = false, destination }: LoggerOptions): Logger {
  const options = {
    level,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    ...(pretty && !destination ? { transport: { target: "pino-pretty" } } : {}),
  };
  return destination ? pino(options, destination) : pino(options);
}
