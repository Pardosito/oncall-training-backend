import type { Session } from "../sessions/index.js";
import type { ScoreRow, StatsQueryName, StatsResponse, TtdTtrRow } from "./stats.schemas.js";

type Ended = Session & { endedAt: string };

/** Ended sessions, oldest first (ULIDs sort by creation time). */
function endedAttempts(sessions: readonly Session[]): Ended[] {
  return sessions
    .filter((s): s is Ended => (s.state === "RESOLVED" || s.state === "FAILED") && !!s.endedAt)
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

export function scoreOverTime(sessions: readonly Session[]): ScoreRow[] {
  return endedAttempts(sessions).map((s, i) => ({
    attempt: i + 1,
    sessionId: s.sessionId,
    scenarioId: s.scenarioId,
    endedAt: s.endedAt,
    state: s.state,
    score: s.score ?? 0,
  }));
}

export function ttdTtrByAttempt(sessions: readonly Session[]): TtdTtrRow[] {
  return endedAttempts(sessions).map((s, i) => ({
    attempt: i + 1,
    sessionId: s.sessionId,
    scenarioId: s.scenarioId,
    endedAt: s.endedAt,
    state: s.state,
    ttdSeconds: s.ttdSeconds ?? null,
    ttrSeconds: s.state === "RESOLVED" ? (s.ttrSeconds ?? null) : null,
  }));
}

export function computeStats(query: StatsQueryName, sessions: readonly Session[]): StatsResponse {
  return query === "score-over-time"
    ? { query, rows: scoreOverTime(sessions) }
    : { query, rows: ttdTtrByAttempt(sessions) };
}
