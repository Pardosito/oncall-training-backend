import { describe, expect, it } from "vitest";
import { type Session, SessionStateSchema, type SessionState } from "./sessions.schemas.js";
import { canTransition, isTerminal, toSessionView } from "./sessions.transitions.js";

const STATES = SessionStateSchema.options;
const ALLOWED = new Set([
  "STARTING->INCIDENT_ACTIVE",
  "STARTING->FAILED",
  "INCIDENT_ACTIVE->RESOLVED",
  "INCIDENT_ACTIVE->FAILED",
]);

describe("canTransition", () => {
  const matrix = STATES.flatMap((from) =>
    STATES.map((to): [SessionState, SessionState] => [from, to]),
  );

  it.each(matrix)("%s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(ALLOWED.has(`${from}->${to}`));
  });
});

describe("isTerminal", () => {
  it.each([
    ["STARTING", false],
    ["INCIDENT_ACTIVE", false],
    ["RESOLVED", true],
    ["FAILED", true],
  ] as const)("%s is terminal: %s", (state, terminal) => {
    expect(isTerminal(state)).toBe(terminal);
  });
});

describe("toSessionView", () => {
  it("drops owner and internal fields", () => {
    const session: Session = {
      userId: "user-1",
      sessionId: "01JBQ4ZJ8V2N7K3M5P6R8S9T0W",
      username: "ian",
      scenarioId: "orders-down",
      state: "RESOLVED",
      executionArn: "arn:aws:states:us-east-1:1:execution:x:y",
      createdAt: "2026-11-05T18:00:00.000Z",
      updatedAt: "2026-11-05T18:05:00.000Z",
      validFixAppliedAt: "2026-11-05T18:03:00.000Z",
      wrongActions: 1,
      actionsCount: 3,
      score: 800,
    };

    const view = toSessionView(session);

    expect(view).toMatchObject({
      sessionId: session.sessionId,
      state: "RESOLVED",
      score: 800,
      actionsCount: 3,
    });
    expect(Object.keys(view)).not.toEqual(
      expect.arrayContaining(["userId", "username", "executionArn", "validFixAppliedAt"]),
    );
    expect(JSON.stringify(view)).not.toMatch(/user-1|executionArn|validFixAppliedAt/);
  });
});
