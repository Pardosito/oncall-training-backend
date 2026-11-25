import request from "supertest";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { createLogger } from "../../platform/logger.js";
import { bodyOf } from "../../test-support/http.js";
import { ordersDownScenario } from "../../test-support/scenarios.js";
import { makeSession, T0 } from "../../test-support/sessions.js";
import { createAuthMiddleware } from "../auth/index.js";
import { createStaticScenariosRepo } from "../scenarios/index.js";
import { createInMemorySessionsRepo, type Session } from "../sessions/index.js";
import { leaderboardRouter } from "./leaderboard.routes.js";
import { createLeaderboardService, rank } from "./leaderboard.service.js";
import type { LeaderboardResponse } from "./leaderboard.schemas.js";

const resolved = (userId: string, username: string, score: number): Session =>
  makeSession({
    userId,
    username,
    sessionId: ulid(),
    state: "RESOLVED",
    score,
    ttrSeconds: 60,
    endedAt: T0.toISOString(),
  });

describe("rank", () => {
  it("gives equal scores the same rank and marks the caller", () => {
    const entries = rank(
      [resolved("a", "alice", 90), resolved("b", "bob", 90), resolved("c", "carol", 70)],
      "b",
    );
    expect(entries.map((e) => [e.rank, e.username, e.isYou])).toEqual([
      [1, "alice", false],
      [1, "bob", true],
      [3, "carol", false],
    ]);
  });
});

describe("leaderboard names", () => {
  it("shows 'player' instead of a user id when the username is missing or equals the user id", () => {
    const entries = rank(
      [resolved("user-x", "user-x", 90), resolved("user-y", "", 80), resolved("user-z", "zoe", 70)],
      "user-z",
    );
    expect(entries.map((e) => [e.username, e.isYou])).toEqual([
      ["player", false],
      ["player", false],
      ["zoe", true],
    ]);
    expect(JSON.stringify(entries)).not.toContain("user-x");
  });
});

describe("GET /api/leaderboard/:scenarioId", () => {
  async function makeApp() {
    const sessions = createInMemorySessionsRepo();
    for (const s of [
      resolved("user-a", "alice", 80),
      resolved("user-b", "bob", 95),
      makeSession({ userId: "user-c", sessionId: ulid(), state: "FAILED", score: 0 }),
    ]) {
      await sessions.create(s);
    }
    const logger = createLogger({ level: "silent" });
    const service = createLeaderboardService({
      sessions,
      scenarios: createStaticScenariosRepo([ordersDownScenario()]),
    });
    return createApp({
      logger,
      readinessChecks: [],
      auth: createAuthMiddleware({ mode: "dev", logger }),
      routers: [leaderboardRouter({ service })],
    });
  }

  it("ranks resolved attempts and never exposes user ids", async () => {
    const res = await request(await makeApp())
      .get("/api/leaderboard/orders-down")
      .set("x-dev-user", "user-a:alice");
    expect(res.status).toBe(200);
    const body = bodyOf<LeaderboardResponse>(res);
    expect(body.entries.map((e) => [e.rank, e.username, e.score, e.isYou])).toEqual([
      [1, "bob", 95, false],
      [2, "alice", 80, true],
    ]);
    expect(JSON.stringify(body)).not.toContain("user-b");
  });

  it("404s for an unknown scenario", async () => {
    const res = await request(await makeApp())
      .get("/api/leaderboard/nope")
      .set("x-dev-user", "user-a");
    expect(res.status).toBe(404);
  });
});
