import { ulid } from "ulid";
import type { Clock } from "../../platform/clock.js";
import { conflict, notFound, unprocessable } from "../../platform/errors.js";
import type { MessageQueue } from "../../platform/queue.js";
import type { AuthUser } from "../auth/index.js";
import type { MockClusterGateway } from "../mock-cluster/index.js";
import type { Scenario, ScenariosRepo } from "../scenarios/index.js";
import { isTerminal, type Session, type SessionsRepo } from "../sessions/index.js";
import { checkActionAllowed } from "./actions.rules.js";
import {
  type ActionRequest,
  LOG_TAIL_LINES,
  type LogsResponse,
  type UserMessage,
  UserMessageSchema,
} from "./actions.schemas.js";

export type ActionsService = ReturnType<typeof createActionsService>;

/** API side of actions (ARCHITECTURE §5): validate, then queue for the worker or read logs. */
export function createActionsService(deps: {
  sessions: SessionsRepo;
  scenarios: ScenariosRepo;
  queue: MessageQueue;
  userActionsQueueUrl: string;
  cluster: MockClusterGateway;
  clock: Clock;
  newId?: () => string;
}) {
  const newId = deps.newId ?? (() => ulid());

  /** Ownership first: someone else's session is a 404 (ARCHITECTURE §3). */
  async function load(
    user: AuthUser,
    sessionId: string,
  ): Promise<{ session: Session; scenario: Scenario }> {
    const session = await deps.sessions.get({ userId: user.userId, sessionId });
    if (!session) throw notFound("Session not found.");
    const scenario = await deps.scenarios.get(session.scenarioId);
    if (!scenario) throw notFound("Scenario not found.");
    return { session, scenario };
  }

  async function enqueue(message: UserMessage): Promise<string> {
    // Validate the exact wire shape (§8.5) so the worker never receives poison from us.
    UserMessageSchema.parse(message);
    await deps.queue.send(deps.userActionsQueueUrl, message, {
      groupId: message.sessionId,
      dedupId: message.actionId,
    });
    return message.actionId;
  }

  const routing = (user: AuthUser, sessionId: string) => ({
    kind: "USER" as const,
    actionId: newId(),
    sessionId,
    userId: user.userId,
    requestedAt: deps.clock.now().toISOString(),
  });

  return {
    async submit(user: AuthUser, sessionId: string, action: ActionRequest): Promise<string> {
      const { session, scenario } = await load(user, sessionId);
      const check = checkActionAllowed(scenario, session, action);
      if (!check.allowed) {
        throw check.reason === "SESSION_NOT_ACTIVE"
          ? conflict("SESSION_NOT_ACTIVE", check.message)
          : unprocessable("ACTION_NOT_ALLOWED", check.message);
      }
      return enqueue({ ...action, ...routing(user, sessionId) });
    },

    async abandon(user: AuthUser, sessionId: string): Promise<string> {
      const { session } = await load(user, sessionId);
      if (isTerminal(session.state)) {
        throw conflict("SESSION_NOT_ACTIVE", `The session is ${session.state}.`);
      }
      return enqueue({ type: "ABANDON", ...routing(user, sessionId) });
    },

    /** VIEW_LOGS: synchronous, never queued (D-15). The target is checked before any k8s call. */
    async logs(user: AuthUser, sessionId: string, service: string): Promise<LogsResponse> {
      const { session, scenario } = await load(user, sessionId);
      if (!scenario.availableActions.includes("VIEW_LOGS")) {
        throw unprocessable("ACTION_NOT_ALLOWED", "VIEW_LOGS is not available in this scenario.");
      }
      if (!scenario.targets.includes(service)) {
        throw unprocessable("ACTION_NOT_ALLOWED", `${service} is not a target in this scenario.`);
      }
      if (session.state !== "INCIDENT_ACTIVE") {
        throw conflict("SESSION_NOT_ACTIVE", `The session is ${session.state}.`);
      }
      return { service, lines: await deps.cluster.readLogs(service, LOG_TAIL_LINES) };
    },
  };
}
