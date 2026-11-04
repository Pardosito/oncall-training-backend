import { ulid } from "ulid";
import type { Session } from "../modules/sessions/index.js";

export const T0 = new Date("2026-11-05T18:00:00.000Z");

export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    userId: "user-a",
    sessionId: ulid(T0.getTime()),
    username: "alice",
    scenarioId: "orders-down",
    state: "STARTING",
    createdAt: T0.toISOString(),
    updatedAt: T0.toISOString(),
    wrongActions: 0,
    actionsCount: 0,
    ...overrides,
  };
}
