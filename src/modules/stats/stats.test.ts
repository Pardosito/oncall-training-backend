import request from "supertest";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { createLogger } from "../../platform/logger.js";
import { bodyOf, errorOf } from "../../test-support/http.js";
import { makeSession, T0 } from "../../test-support/sessions.js";
import { createAuthMiddleware } from "../auth/index.js";
import { createInMemorySessionsRepo, type Session } from "../sessions/index.js";
import { scoreOverTime, ttdTtrByAttempt } from "./stats.compute.js";
import { statsRouter } from "./stats.routes.js";
import type { ScoreRow } from "./stats.schemas.js";
import { createStatsService, MAX_SESSIONS } from "./stats.service.js";

const at = (s: number) => new Date(T0.getTime() + s * 1000);
const iso = (s: number) => at(s).toISOString();

function attempt(seconds: number, overrides: Partial<Session>): Session {
  return makeSession({ sessionId: ulid(at(seconds).getTime()), ...overrides });
}

const history: Session[] = [
  attempt(300, { state: "RESOLVED", endedAt: iso(400), score: 80, ttdSeconds: 30, ttrSeconds: 90 }),
  attempt(100, { state: "FAILED", endedAt: iso(200), score: 0, failureReason: "TIMEOUT" }),
  attempt(500, { state: "INCIDENT_ACTIVE" }),
  attempt(600, {
    state: "FAILED",
    endedAt: iso(700),
    score: 0,
    ttdSeconds: 12,
    ttrSeconds: 99,
    failureReason: "ABANDONED",
  }),
];

describe("stats compute (D-36)", () => {
  it("numbers ended attempts oldest first and skips active ones", () => {
    expect(scoreOverTime(history).map((r) => [r.attempt, r.state, r.score])).toEqual([
      [1, "FAILED", 0],
      [2, "RESOLVED", 80],
      [3, "FAILED", 0],
    ]);
  });

  it("reports TTD when acknowledged and TTR only for resolved attempts", () => {
    expect(ttdTtrByAttempt(history).map((r) => [r.ttdSeconds, r.ttrSeconds])).toEqual([
      [null, null],
      [30, 90],
      [12, null],
    ]);
  });

  it("is empty without ended attempts", () => {
    expect(scoreOverTime([])).toEqual([]);
  });
});

describe("stats service paging (D-36)", () => {
  async function repoWith(count: number) {
    const repo = createInMemorySessionsRepo();
    // One ended attempt per second, so the ULIDs sort by creation order.
    for (let i = 1; i <= count; i++) {
      await repo.create(attempt(i, { state: "RESOLVED", endedAt: iso(i), score: i }));
    }
    return repo;
  }
  const user = { userId: "user-a", username: "alice" };

  it("reads every page of a user with more than 50 sessions", async () => {
    const service = createStatsService({ sessions: await repoWith(120) });
    const { rows } = (await service.get(user, "score-over-time")) as { rows: ScoreRow[] };
    expect(rows).toHaveLength(120);
    expect(rows.map((r) => r.attempt)).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
    expect(rows.at(-1)?.score).toBe(120);
  });

  it(`caps the history at MAX_SESSIONS (${MAX_SESSIONS}), keeping the newest`, async () => {
    const total = MAX_SESSIONS + 20;
    const service = createStatsService({ sessions: await repoWith(total) });
    const { rows } = (await service.get(user, "score-over-time")) as { rows: ScoreRow[] };
    expect(rows).toHaveLength(MAX_SESSIONS);
    // The window is the newest MAX_SESSIONS; attempt 1 is its oldest ended session.
    expect(rows[0]?.score).toBe(total - MAX_SESSIONS + 1);
    expect(rows.at(-1)?.score).toBe(total);
  });
});

describe("GET /api/me/stats/:queryName", () => {
  async function appWith(sessions: Session[]) {
    const repo = createInMemorySessionsRepo();
    for (const s of sessions) await repo.create(s);
    const logger = createLogger({ level: "silent" });
    return createApp({
      logger,
      readinessChecks: [],
      auth: createAuthMiddleware({ mode: "dev", logger }),
      routers: [statsRouter({ service: createStatsService({ sessions: repo }) })],
    });
  }

  it("returns only the caller's rows", async () => {
    const other = attempt(800, {
      userId: "user-b",
      state: "RESOLVED",
      endedAt: iso(900),
      score: 99,
    });
    const app = await appWith([...history, other]);
    const res = await request(app)
      .get("/api/me/stats/score-over-time")
      .set("x-dev-user", "user-a:alice");
    expect(res.status).toBe(200);
    const body = bodyOf<{ query: string; rows: { score: number }[] }>(res);
    expect(body.query).toBe("score-over-time");
    expect(body.rows.map((r) => r.score)).toEqual([0, 80, 0]);
  });

  it("rejects an unknown query with 400", async () => {
    const app = await appWith([]);
    const res = await request(app).get("/api/me/stats/nope").set("x-dev-user", "user-a");
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe("VALIDATION_ERROR");
  });
});
