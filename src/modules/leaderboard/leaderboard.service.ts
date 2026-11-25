import { notFound } from "../../platform/errors.js";
import type { AuthUser } from "../auth/index.js";
import type { ScenariosRepo } from "../scenarios/index.js";
import type { Session, SessionsRepo } from "../sessions/index.js";
import type { LeaderboardEntry, LeaderboardResponse } from "./leaderboard.schemas.js";

export type LeaderboardService = ReturnType<typeof createLeaderboardService>;

/** Shown when a session has no usable name. Never fall back to the user id (AGENTS §3). */
export const FALLBACK_NAME = "player";

/** The public name of a session's player: the copied username, unless it is missing or a user id. */
export function displayName(s: Pick<Session, "userId" | "username">): string {
  return !s.username || s.username === s.userId ? FALLBACK_NAME : s.username;
}

/** Ranks sessions already sorted by score (best first); equal scores share a rank. */
export function rank(top: readonly Session[], callerId: string): LeaderboardEntry[] {
  const entries: LeaderboardEntry[] = [];
  top.forEach((s, i) => {
    const score = s.score ?? 0;
    const previous = entries[i - 1];
    entries.push({
      rank: previous && previous.score === score ? previous.rank : i + 1,
      username: displayName(s),
      score,
      ...(s.ttdSeconds !== undefined ? { ttdSeconds: s.ttdSeconds } : {}),
      ...(s.ttrSeconds !== undefined ? { ttrSeconds: s.ttrSeconds } : {}),
      wrongActions: s.wrongActions,
      ...(s.endedAt ? { endedAt: s.endedAt } : {}),
      isYou: s.userId === callerId,
    });
  });
  return entries;
}

export function createLeaderboardService(deps: {
  sessions: SessionsRepo;
  scenarios: ScenariosRepo;
}) {
  return {
    async get(user: AuthUser, scenarioId: string, limit: number): Promise<LeaderboardResponse> {
      if (!(await deps.scenarios.get(scenarioId))) throw notFound("Scenario not found.");
      const top = await deps.sessions.topScores(scenarioId, limit);
      return { scenarioId, entries: rank(top, user.userId) };
    },
  };
}
