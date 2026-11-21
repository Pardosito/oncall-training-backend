import {
  SendTaskFailureCommand,
  SendTaskSuccessCommand,
  type SFNClient,
  StartExecutionCommand,
} from "@aws-sdk/client-sfn";
import { ulid } from "ulid";
import { beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../../platform/logger.js";
import { ordersDownScenario } from "../../test-support/scenarios.js";
import { makeSession, T0 } from "../../test-support/sessions.js";
import { createInMemorySessionsRepo, type Session } from "../sessions/index.js";
import { ExecutionInputSchema } from "./orchestration.schemas.js";
import {
  ABANDONED_ERROR,
  createStepFunctionsOrchestration,
} from "./orchestration.stepfunctions.js";

const STATE_MACHINE = "arn:aws:states:us-east-1:123456789012:stateMachine:oncall-training-scenario";
const scenario = ordersDownScenario();
const output = {
  resolvedAt: "2026-11-21T10:00:00.000Z",
  ttdSeconds: 42,
  ttrSeconds: 131,
  wrongActions: 1,
  actionsCount: 4,
  score: 802,
};

const named = (name: string) => Object.assign(new Error(name), { name });

type Command = StartExecutionCommand | SendTaskSuccessCommand | SendTaskFailureCommand;
let sent: Command[];
let reply: (command: Command) => unknown;
let sessions: ReturnType<typeof createInMemorySessionsRepo>;
let orchestration: ReturnType<typeof createStepFunctionsOrchestration>;
let session: Session;

beforeEach(async () => {
  sent = [];
  reply = () => ({});
  const sfn = {
    send: async (command: Command) => {
      sent.push(command);
      await Promise.resolve();
      return reply(command);
    },
  } as unknown as Pick<SFNClient, "send">;
  sessions = createInMemorySessionsRepo();
  orchestration = createStepFunctionsOrchestration({
    sfn,
    stateMachineArn: STATE_MACHINE,
    sessions,
    logger: createLogger({ level: "silent" }),
  });
  session = makeSession({ state: "INCIDENT_ACTIVE", faultInjectedAt: T0.toISOString() });
  await sessions.create(session);
});

describe("start", () => {
  it("starts an execution named after the session with the §8.1 input", async () => {
    const faultId = ulid();
    reply = () => ({ executionArn: "arn:exec" });

    const result = await orchestration.start({
      session,
      scenario,
      faultId,
      namespace: "mock",
      at: T0,
    });

    expect(result).toEqual({ executionArn: "arn:exec" });
    const [command] = sent;
    expect(command).toBeInstanceOf(StartExecutionCommand);
    const input = command?.input as { stateMachineArn: string; name: string; input: string };
    expect(input.stateMachineArn).toBe(STATE_MACHINE);
    expect(input.name).toBe(session.sessionId);
    expect(ExecutionInputSchema.parse(JSON.parse(input.input))).toEqual({
      userId: session.userId,
      sessionId: session.sessionId,
      scenarioId: scenario.id,
      warmupSeconds: scenario.warmupSeconds,
      maxResolveSeconds: scenario.maxResolveSeconds,
      fault: {
        faultId,
        type: "SCALE_TO_ZERO",
        target: { namespace: "mock", deployment: "orders" },
      },
    });
  });

  it("treats ExecutionAlreadyExists as started and rebuilds the execution ARN", async () => {
    reply = () => {
      throw named("ExecutionAlreadyExists");
    };
    const result = await orchestration.start({
      session,
      scenario,
      faultId: ulid(),
      namespace: "mock",
      at: T0,
    });
    expect(result.executionArn).toBe(
      `arn:aws:states:us-east-1:123456789012:execution:oncall-training-scenario:${session.sessionId}`,
    );
  });

  it("rethrows other errors so the api marks the session FAILED", async () => {
    reply = () => {
      throw named("StateMachineDoesNotExist");
    };
    await expect(
      orchestration.start({ session, scenario, faultId: ulid(), namespace: "mock", at: T0 }),
    ).rejects.toThrow("StateMachineDoesNotExist");
  });
});

describe("completeTask", () => {
  it("sends SendTaskSuccess with the stored token and the §8.2 output, writing nothing", async () => {
    await sessions.setTaskToken(session, "token-1", T0);

    expect(await orchestration.completeTask({ key: session, output })).toBe("ok");

    const [command] = sent;
    expect(command).toBeInstanceOf(SendTaskSuccessCommand);
    expect(command?.input).toEqual({ taskToken: "token-1", output: JSON.stringify(output) });
    expect((await sessions.get(session))?.state).toBe("INCIDENT_ACTIVE");
  });

  it("throws while there is no token yet, so the monitor tries again", async () => {
    await expect(orchestration.completeTask({ key: session, output })).rejects.toThrow(
      /no task token/,
    );
    expect(sent).toEqual([]);
  });

  it.each(["TaskTimedOut", "InvalidToken", "TaskDoesNotExist"])(
    "reports %s as already-ended",
    async (name) => {
      await sessions.setTaskToken(session, "token-1", T0);
      reply = () => {
        throw named(name);
      };
      expect(await orchestration.completeTask({ key: session, output })).toBe("already-ended");
    },
  );
});

describe("failTask", () => {
  it("fails the task with Abandoned so the state machine records ABANDONED", async () => {
    await sessions.setTaskToken(session, "token-1", T0);

    const result = await orchestration.failTask({
      key: session,
      from: "INCIDENT_ACTIVE",
      reason: "ABANDONED",
      at: T0,
    });

    expect(result).toBe("ok");
    const [command] = sent;
    expect(command).toBeInstanceOf(SendTaskFailureCommand);
    expect(command?.input).toMatchObject({ taskToken: "token-1", error: ABANDONED_ERROR });
    expect((await sessions.get(session))?.state).toBe("INCIDENT_ACTIVE");
  });

  it("uses the token it is given (AWAIT_FIX for an ended session)", async () => {
    await orchestration.failTask({
      key: session,
      taskToken: "token-from-message",
      from: "FAILED",
      reason: "ABANDONED",
      at: T0,
    });
    expect(sent[0]?.input).toMatchObject({ taskToken: "token-from-message" });
  });

  it("without a token (abandon during the warmup) writes FAILED itself and calls nothing", async () => {
    const starting = makeSession({ sessionId: ulid(), state: "STARTING" });
    await sessions.create(starting);

    const result = await orchestration.failTask({
      key: starting,
      from: "STARTING",
      reason: "ABANDONED",
      at: T0,
    });

    expect(result).toBe("ok");
    expect(sent).toEqual([]);
    expect(await sessions.get(starting)).toMatchObject({
      state: "FAILED",
      failureReason: "ABANDONED",
      endedAt: T0.toISOString(),
    });
  });

  it("without a token on an ended session reports already-ended", async () => {
    const result = await orchestration.failTask({
      key: session,
      from: "STARTING",
      reason: "ABANDONED",
      at: T0,
    });
    expect(result).toBe("already-ended");
  });
});
