import { ulid } from "ulid";
import { beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../../platform/logger.js";
import { createInMemoryQueue } from "../../platform/queue.js";
import { ordersDownScenario } from "../../test-support/scenarios.js";
import { makeSession, T0 } from "../../test-support/sessions.js";
import { QueueMessageSchema } from "../actions/index.js";
import { createInMemorySessionsRepo } from "../sessions/index.js";
import { createDirectOrchestration } from "./orchestration.direct.js";
import { FaultMessageSchema } from "./orchestration.schemas.js";

const FAULTS = "faults";
const ACTIONS = "user-actions.fifo";
const logger = createLogger({ level: "silent" });
const scenario = ordersDownScenario();

let clock: number;
let queue: ReturnType<typeof createInMemoryQueue>;
let sessions: ReturnType<typeof createInMemorySessionsRepo>;
let orchestration: ReturnType<typeof createDirectOrchestration>;

beforeEach(() => {
  clock = T0.getTime();
  queue = createInMemoryQueue({ now: () => clock });
  sessions = createInMemorySessionsRepo();
  orchestration = createDirectOrchestration({
    sessions,
    queue,
    logger,
    faultsQueueUrl: FAULTS,
    userActionsQueueUrl: ACTIONS,
  });
});

describe("direct orchestration", () => {
  it("start sends the FAULT message (infra §7) delayed by the warmup", async () => {
    const session = makeSession();
    const faultId = ulid();

    await orchestration.start({ session, scenario, faultId, namespace: "mock", at: T0 });

    expect(await queue.receive(FAULTS)).toEqual([]);
    clock += scenario.warmupSeconds * 1000;
    const [message] = await queue.receive(FAULTS);
    expect(FaultMessageSchema.parse(JSON.parse(message?.body ?? ""))).toEqual({
      faultId,
      sessionId: session.sessionId,
      userId: session.userId,
      type: "SCALE_TO_ZERO",
      target: { namespace: "mock", deployment: "orders" },
      sentAt: T0.toISOString(),
    });
  });

  it("start refuses without a faults queue (worker side)", async () => {
    const worker = createDirectOrchestration({
      sessions,
      queue,
      logger,
      userActionsQueueUrl: ACTIONS,
    });
    await expect(
      worker.start({
        session: makeSession(),
        scenario,
        faultId: ulid(),
        namespace: "mock",
        at: T0,
      }),
    ).rejects.toThrow("FAULTS_QUEUE_URL");
  });

  it("completeTask writes RESOLVED with the score and sends SESSION_ENDED", async () => {
    const session = makeSession({ state: "INCIDENT_ACTIVE" });
    await sessions.create(session);
    const resolvedAt = "2026-11-05T18:02:00.000Z";

    const result = await orchestration.completeTask({
      key: session,
      output: {
        resolvedAt,
        ttdSeconds: 10,
        ttrSeconds: 100,
        wrongActions: 1,
        actionsCount: 3,
        score: 865,
      },
    });

    expect(result).toBe("ok");
    expect(await sessions.get(session)).toMatchObject({
      state: "RESOLVED",
      endedAt: resolvedAt,
      score: 865,
      ttdSeconds: 10,
      ttrSeconds: 100,
    });
    expect(queue.pending(ACTIONS).map((m) => QueueMessageSchema.parse(m))).toEqual([
      {
        kind: "SYSTEM",
        type: "SESSION_ENDED",
        userId: session.userId,
        sessionId: session.sessionId,
        outcome: "RESOLVED",
        reason: null,
      },
    ]);
  });

  it("failTask writes FAILED with the reason and sends SESSION_ENDED", async () => {
    const session = makeSession();
    await sessions.create(session);
    const at = new Date("2026-11-05T18:01:00.000Z");

    expect(
      await orchestration.failTask({ key: session, from: "STARTING", reason: "ERROR", at }),
    ).toBe("ok");

    expect(await sessions.get(session)).toMatchObject({
      state: "FAILED",
      failureReason: "ERROR",
      endedAt: at.toISOString(),
    });
    expect(queue.pending(ACTIONS)).toMatchObject([{ outcome: "FAILED", reason: "ERROR" }]);
  });

  it("reports already-ended and sends nothing when the session moved on", async () => {
    const session = makeSession({ state: "FAILED" });
    await sessions.create(session);

    const result = await orchestration.failTask({
      key: session,
      from: "INCIDENT_ACTIVE",
      reason: "TIMEOUT",
      at: T0,
    });

    expect(result).toBe("already-ended");
    expect(queue.pending(ACTIONS)).toEqual([]);
  });
});
