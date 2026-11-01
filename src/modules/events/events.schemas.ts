import { z } from "zod";

/** Event types (ARCHITECTURE §7.4); also shown in the dashboard's `recentEvents`. */
export const EventTypeSchema = z
  .enum([
    "SESSION_STARTED",
    "FAULT_INJECTED",
    "ACKNOWLEDGED",
    "ACTION",
    "VIEW_LOGS",
    "RESOLVED",
    "FAILED",
    "SCORED",
  ])
  .meta({ id: "EventType" });
export type EventType = z.infer<typeof EventTypeSchema>;
