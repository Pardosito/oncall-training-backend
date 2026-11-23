import { beforeEach, describe, expect, it } from "vitest";
import { createFixedClock } from "../../platform/clock.js";
import { AppError } from "../../platform/errors.js";
import { createInMemoryLock, type Lock } from "../../platform/lock.js";
import { createLogger } from "../../platform/logger.js";
import { ordersDownScenario } from "../../test-support/scenarios.js";
import { makeSession, T0 } from "../../test-support/sessions.js";
import { createFakeOrchestration } from "../orchestration/index.js";
import { createStaticScenariosRepo } from "../scenarios/index.js";
import { createInMemorySessionsRepo } from "./sessions.repo.js";
import { createSessionsService } from "./sessions.service.js";

const user = { userId: "user-a", username: "alice" };
const logger = createLogger({ level: "silent" });

function setup(options: { failStart?: Error; lock?: boolean } = {}) {
  const sessions = createInMemorySessionsRepo();
  const clock = createFixedClock(T0);
  const fake = createFakeOrchestration(options);
  const lock: Lock | undefined = options.lock ? createInMemoryLock(clock) : undefined;
  let n = 0;
  const service = createSessionsService({
    sessions,
    scenarios: createStaticScenariosRepo([ordersDownScenario()]),
    orchestration: fake.orchestration,
    clock,
    logger,
    namespace: "mock",
    ...(lock ? { lock } : {}),
    newId: () => `01JC0000000000000000000${String(++n).padStart(3, "0")}`,
  });
  return { service, sessions, clock, calls: fake.calls, lock };
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

describe("startSession", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("writes a STARTING session and starts the orchestration", async () => {
    const session = await ctx.service.startSession(user, "orders-down");

    expect(session).toMatchObject({
      userId: "user-a",
      username: "alice",
      scenarioId: "orders-down",
      state: "STARTING",
      createdAt: T0.toISOString(),
      wrongActions: 0,
      actionsCount: 0,
    });
    expect(await ctx.sessions.get(session)).toEqual(session);
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0]).toMatchObject({
      method: "start",
      input: { session, namespace: "mock", faultId: "01JC0000000000000000000002" },
    });
  });

  it("returns 404 for an unknown scenario without writing anything", async () => {
    const error = await rejection(ctx.service.startSession(user, "nope"));
    expect(error.httpStatus).toBe(404);
    expect(ctx.sessions.all()).toEqual([]);
  });

  it("returns 409 SESSION_BUSY with retryAfterSeconds while another session is active", async () => {
    await ctx.sessions.create(
      makeSession({
        userId: "user-b",
        state: "INCIDENT_ACTIVE",
        faultInjectedAt: T0.toISOString(),
      }),
    );
    ctx.clock.advance(100);

    const error = await rejection(ctx.service.startSession(user, "orders-down"));

    expect(error).toMatchObject({ code: "SESSION_BUSY", httpStatus: 409 });
    expect(error.details).toEqual({ retryAfterSeconds: 500 });
    expect(ctx.calls).toEqual([]);
  });

  it("starts again once the previous session ended", async () => {
    await ctx.sessions.create(makeSession({ state: "RESOLVED" }));
    await expect(ctx.service.startSession(user, "orders-down")).resolves.toBeDefined();
  });

  it("marks the session FAILED and rethrows when the orchestration fails", async () => {
    const failing = setup({ failStart: new Error("SQS down") });

    await expect(failing.service.startSession(user, "orders-down")).rejects.toThrow("SQS down");

    expect(failing.sessions.all()).toMatchObject([
      { state: "FAILED", failureReason: "ERROR", endedAt: T0.toISOString() },
    ]);
  });
});

describe("getSession", () => {
  it("returns the caller's session and 404 for anyone else", async () => {
    const ctx = setup();
    const session = await ctx.service.startSession(user, "orders-down");

    await expect(ctx.service.getSession(user, session.sessionId)).resolves.toEqual(session);
    const error = await rejection(
      ctx.service.getSession({ userId: "user-b", username: "bob" }, session.sessionId),
    );
    expect(error.httpStatus).toBe(404);
  });
});

describe("startSession with the global lock", () => {
  it("holds the lock for the new session with the scenario's TTL", async () => {
    const ctx = setup({ lock: true });
    const session = await ctx.service.startSession(user, "orders-down");

    expect(await ctx.lock?.holder()).toBe(session.sessionId);
    const scenario = ordersDownScenario();
    expect(await ctx.lock?.remainingMs()).toBe(
      (scenario.warmupSeconds + scenario.maxResolveSeconds + 180) * 1000,
    );
  });

  it("returns 409 SESSION_BUSY with the lock's remaining TTL, without writing a session", async () => {
    const ctx = setup({ lock: true });
    await ctx.lock?.acquire("someone-else", 90_500);
    ctx.clock.advance(30);

    const error = await rejection(ctx.service.startSession(user, "orders-down"));

    expect(error).toMatchObject({ code: "SESSION_BUSY", httpStatus: 409 });
    expect(error.details).toEqual({ retryAfterSeconds: 61 });
    expect(ctx.sessions.all()).toEqual([]);
  });

  it("releases the lock when the orchestration can't start", async () => {
    const ctx = setup({ lock: true, failStart: new Error("sfn down") });

    await expect(ctx.service.startSession(user, "orders-down")).rejects.toThrow("sfn down");

    expect(await ctx.lock?.holder()).toBeNull();
    expect(ctx.sessions.all()[0]).toMatchObject({ state: "FAILED" });
  });
});
