import type { AuthUser } from "../auth/index.js";
import type { Session, SessionsRepo } from "../sessions/index.js";
import { computeStats } from "./stats.compute.js";
import type { StatsQueryName, StatsResponse } from "./stats.schemas.js";

const PAGE = 50;
/** Enough history for the charts; a user past this sees their latest attempts only. */
export const MAX_SESSIONS = 500;

export type StatsService = ReturnType<typeof createStatsService>;

/**
 * Stats straight from DynamoDB (D-36): one `Query` on the user's partition, then pure math.
 * Replaces the Athena design; Glue and Athena aren't usable with the lab's role.
 */
export function createStatsService(deps: { sessions: SessionsRepo }) {
  async function mySessions(userId: string): Promise<Session[]> {
    const all: Session[] = [];
    let cursor: string | undefined;
    do {
      const page = await deps.sessions.listByUser(userId, {
        limit: PAGE,
        ...(cursor ? { cursor } : {}),
      });
      all.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor && all.length < MAX_SESSIONS);
    return all.slice(0, MAX_SESSIONS);
  }

  return {
    async get(user: AuthUser, query: StatsQueryName): Promise<StatsResponse> {
      return computeStats(query, await mySessions(user.userId));
    },
  };
}
