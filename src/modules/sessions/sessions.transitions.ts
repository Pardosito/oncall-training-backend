import type { Session, SessionState, SessionView } from "./sessions.schemas.js";

const ALLOWED: Record<SessionState, readonly SessionState[]> = {
  STARTING: ["INCIDENT_ACTIVE", "FAILED"],
  INCIDENT_ACTIVE: ["RESOLVED", "FAILED"],
  RESOLVED: [],
  FAILED: [],
};

/** ARCHITECTURE §4.1. Enforced again in DynamoDB with a condition on the expected state. */
export function canTransition(from: SessionState, to: SessionState): boolean {
  return ALLOWED[from].includes(to);
}

export function isTerminal(state: SessionState): boolean {
  return ALLOWED[state].length === 0;
}

export function toSessionView(session: Session): SessionView {
  return {
    sessionId: session.sessionId,
    scenarioId: session.scenarioId,
    state: session.state,
    createdAt: session.createdAt,
    faultInjectedAt: session.faultInjectedAt,
    acknowledgedAt: session.acknowledgedAt,
    endedAt: session.endedAt,
    score: session.score,
    ttdSeconds: session.ttdSeconds,
    ttrSeconds: session.ttrSeconds,
    wrongActions: session.wrongActions,
    actionsCount: session.actionsCount,
    failureReason: session.failureReason,
  };
}
