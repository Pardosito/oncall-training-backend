import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ATTRIBUTE, fromItem, toItem } from "./sessions.item.js";
import type { Session, SessionState } from "./sessions.schemas.js";
import { canTransition } from "./sessions.transitions.js";

export type SessionKey = { userId: string; sessionId: string };

/** Fields a state transition may set alongside the new state. */
export type TransitionFields = Partial<
  Pick<
    Session,
    "faultInjectedAt" | "endedAt" | "failureReason" | "score" | "ttdSeconds" | "ttrSeconds"
  >
>;

export type Transition = {
  from: SessionState;
  to: SessionState;
  at: Date;
  set?: TransitionFields;
};

/** The session wasn't in the expected state (or doesn't exist). Replaces the SDK's condition error. */
export class SessionStateConflict extends Error {
  constructor(
    readonly key: SessionKey,
    readonly expected: string,
  ) {
    super(`session ${key.sessionId} is not ${expected}`);
    this.name = "SessionStateConflict";
  }
}

export const ACTIVE_STATES: readonly SessionState[] = ["STARTING", "INCIDENT_ACTIVE"];

export type SessionsRepo = {
  /** Writes a new item; throws `SessionStateConflict` if the id already exists. */
  create(session: Session): Promise<void>;
  get(key: SessionKey): Promise<Session | undefined>;
  /**
   * MVP only (no Redis lock, D-24/D-30): the newest session in `STARTING` or `INCIDENT_ACTIVE`.
   * A filtered Scan, the one documented exception to "no scans" (ARCHITECTURE §7.1).
   */
  findActive(): Promise<Session | undefined>;
  /** Conditional on `#state = from`; returns the updated session or throws `SessionStateConflict`. */
  transition(key: SessionKey, transition: Transition): Promise<Session>;
  /** First acknowledge after the fault only; returns whether it was recorded. */
  markAcknowledged(key: SessionKey, at: Date): Promise<boolean>;
  /** First valid fix while the incident is active only; returns whether it was recorded. */
  markValidFix(key: SessionKey, at: Date): Promise<boolean>;
  /** Atomic `ADD` on `actions_count` and `wrong_actions`. */
  incrementCounters(
    key: SessionKey,
    by: { actions: number; wrong: number },
    at: Date,
  ): Promise<void>;
};

function assertTransition({ from, to }: Transition): void {
  if (!canTransition(from, to)) throw new Error(`illegal session transition ${from} → ${to}`);
}

export function createDynamoSessionsRepo(deps: {
  ddb: DynamoDBDocumentClient;
  table: string;
}): SessionsRepo {
  const { ddb, table: TableName } = deps;
  const Key = ({ userId, sessionId }: SessionKey) => ({ user_id: userId, session_id: sessionId });

  /** Runs a conditional write; a failed condition becomes `false`. */
  async function conditional(write: () => Promise<unknown>): Promise<boolean> {
    try {
      await write();
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false;
      throw error;
    }
  }

  return {
    async create(session) {
      const ok = await conditional(() =>
        ddb.send(
          new PutCommand({
            TableName,
            Item: toItem(session),
            ConditionExpression: "attribute_not_exists(session_id)",
          }),
        ),
      );
      if (!ok) throw new SessionStateConflict(session, "new");
    },

    async get(key) {
      const { Item } = await ddb.send(
        new GetCommand({ TableName, Key: Key(key), ConsistentRead: true }),
      );
      return Item ? fromItem(Item) : undefined;
    },

    async findActive() {
      let newest: Session | undefined;
      let ExclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const page = await ddb.send(
          new ScanCommand({
            TableName,
            FilterExpression: "#state IN (:starting, :active)",
            ExpressionAttributeNames: { "#state": "state" },
            ExpressionAttributeValues: { ":starting": "STARTING", ":active": "INCIDENT_ACTIVE" },
            ConsistentRead: true,
            ExclusiveStartKey,
          }),
        );
        for (const item of page.Items ?? []) {
          const session = fromItem(item);
          if (!newest || session.sessionId > newest.sessionId) newest = session;
        }
        ExclusiveStartKey = page.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return newest;
    },

    async transition(key, transition) {
      assertTransition(transition);
      const names: Record<string, string> = { "#state": "state", "#updated_at": "updated_at" };
      const values: Record<string, unknown> = {
        ":from": transition.from,
        ":to": transition.to,
        ":at": transition.at.toISOString(),
      };
      const sets = ["#state = :to", "#updated_at = :at"];
      for (const [field, value] of Object.entries(transition.set ?? {})) {
        if (value === undefined) continue;
        const attribute = ATTRIBUTE[field as keyof TransitionFields];
        names[`#${attribute}`] = attribute;
        values[`:${attribute}`] = value;
        sets.push(`#${attribute} = :${attribute}`);
      }
      try {
        const { Attributes } = await ddb.send(
          new UpdateCommand({
            TableName,
            Key: Key(key),
            UpdateExpression: `SET ${sets.join(", ")}`,
            ConditionExpression: "#state = :from",
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            ReturnValues: "ALL_NEW",
          }),
        );
        return fromItem(Attributes);
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) {
          throw new SessionStateConflict(key, transition.from);
        }
        throw error;
      }
    },

    markAcknowledged(key, at) {
      return conditional(() =>
        ddb.send(
          new UpdateCommand({
            TableName,
            Key: Key(key),
            UpdateExpression: "SET acknowledged_at = :at, updated_at = :at",
            ConditionExpression: "#state = :active AND attribute_not_exists(acknowledged_at)",
            ExpressionAttributeNames: { "#state": "state" },
            ExpressionAttributeValues: { ":at": at.toISOString(), ":active": "INCIDENT_ACTIVE" },
          }),
        ),
      );
    },

    markValidFix(key, at) {
      return conditional(() =>
        ddb.send(
          new UpdateCommand({
            TableName,
            Key: Key(key),
            UpdateExpression: "SET valid_fix_applied_at = :at, updated_at = :at",
            ConditionExpression: "#state = :active AND attribute_not_exists(valid_fix_applied_at)",
            ExpressionAttributeNames: { "#state": "state" },
            ExpressionAttributeValues: { ":at": at.toISOString(), ":active": "INCIDENT_ACTIVE" },
          }),
        ),
      );
    },

    async incrementCounters(key, by, at) {
      await ddb.send(
        new UpdateCommand({
          TableName,
          Key: Key(key),
          UpdateExpression: "ADD actions_count :actions, wrong_actions :wrong SET updated_at = :at",
          ConditionExpression: "attribute_exists(session_id)",
          ExpressionAttributeValues: {
            ":actions": by.actions,
            ":wrong": by.wrong,
            ":at": at.toISOString(),
          },
        }),
      );
    },
  };
}

/** In-memory implementation with the same conditions, for unit tests and `dev:local`. */
export function createInMemorySessionsRepo(): SessionsRepo & { all(): Session[] } {
  const items = new Map<string, Session>();
  const id = ({ userId, sessionId }: SessionKey) => `${userId}#${sessionId}`;
  const copy = (s: Session): Session => ({ ...s });

  return {
    all: () => [...items.values()].map(copy),

    create(session) {
      if (items.has(id(session))) return Promise.reject(new SessionStateConflict(session, "new"));
      items.set(id(session), copy(session));
      return Promise.resolve();
    },

    get(key) {
      const session = items.get(id(key));
      return Promise.resolve(session && copy(session));
    },

    findActive() {
      const active = [...items.values()]
        .filter((s) => ACTIVE_STATES.includes(s.state))
        .sort((a, b) => b.sessionId.localeCompare(a.sessionId));
      return Promise.resolve(active[0] && copy(active[0]));
    },

    transition(key, transition) {
      if (!canTransition(transition.from, transition.to)) {
        return Promise.reject(
          new Error(`illegal session transition ${transition.from} → ${transition.to}`),
        );
      }
      const session = items.get(id(key));
      if (session?.state !== transition.from) {
        return Promise.reject(new SessionStateConflict(key, transition.from));
      }
      const defined = Object.entries(transition.set ?? {}).filter(([, v]) => v !== undefined);
      const next: Session = {
        ...session,
        ...Object.fromEntries(defined),
        state: transition.to,
        updatedAt: transition.at.toISOString(),
      };
      items.set(id(key), next);
      return Promise.resolve(copy(next));
    },

    markAcknowledged(key, at) {
      const session = items.get(id(key));
      if (session?.state !== "INCIDENT_ACTIVE" || session.acknowledgedAt) {
        return Promise.resolve(false);
      }
      session.acknowledgedAt = session.updatedAt = at.toISOString();
      return Promise.resolve(true);
    },

    markValidFix(key, at) {
      const session = items.get(id(key));
      if (session?.state !== "INCIDENT_ACTIVE" || session.validFixAppliedAt) {
        return Promise.resolve(false);
      }
      session.validFixAppliedAt = session.updatedAt = at.toISOString();
      return Promise.resolve(true);
    },

    incrementCounters(key, by, at) {
      const session = items.get(id(key));
      if (!session) return Promise.reject(new Error(`session ${key.sessionId} not found`));
      session.actionsCount += by.actions;
      session.wrongActions += by.wrong;
      session.updatedAt = at.toISOString();
      return Promise.resolve();
    },
  };
}
