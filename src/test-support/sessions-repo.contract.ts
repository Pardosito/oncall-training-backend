import { ulid } from "ulid";
import { beforeEach, describe, expect, it } from "vitest";
import { type SessionsRepo, SessionStateConflict } from "../modules/sessions/index.js";
import { makeSession, T0 } from "./sessions.js";

const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

/**
 * Behavior every `SessionsRepo` must have. Runs against the in-memory fake (unit) and against
 * DynamoDB in LocalStack (integration), so the fake can't drift from the real conditions.
 */
export function describeSessionsRepoContract(
  name: string,
  makeRepo: () => SessionsRepo,
  userPrefix = "user",
): void {
  describe(`SessionsRepo contract: ${name}`, () => {
    let repo: SessionsRepo;
    let userId: string;
    beforeEach(() => {
      repo = makeRepo();
      userId = `${userPrefix}-${ulid()}`;
    });

    const newSession = (state: "STARTING" | "INCIDENT_ACTIVE" = "STARTING") =>
      makeSession({
        userId,
        sessionId: ulid(),
        state,
        ...(state === "INCIDENT_ACTIVE" ? { faultInjectedAt: at(20).toISOString() } : {}),
      });

    it("creates and reads a session", async () => {
      const session = newSession();
      await repo.create(session);
      expect(await repo.get(session)).toEqual(session);
    });

    it("rejects a duplicate create", async () => {
      const session = newSession();
      await repo.create(session);
      await expect(repo.create(session)).rejects.toBeInstanceOf(SessionStateConflict);
    });

    it("returns undefined for a missing or someone else's session", async () => {
      const session = newSession();
      await repo.create(session);
      expect(await repo.get({ userId: `${userId}-other`, sessionId: session.sessionId })).toBe(
        undefined,
      );
    });

    it("transitions only from the expected state", async () => {
      const session = newSession();
      await repo.create(session);

      const active = await repo.transition(session, {
        from: "STARTING",
        to: "INCIDENT_ACTIVE",
        at: at(20),
        set: { faultInjectedAt: at(20).toISOString() },
      });
      expect(active).toMatchObject({
        state: "INCIDENT_ACTIVE",
        faultInjectedAt: at(20).toISOString(),
        updatedAt: at(20).toISOString(),
      });

      await expect(
        repo.transition(session, { from: "STARTING", to: "FAILED", at: at(30) }),
      ).rejects.toBeInstanceOf(SessionStateConflict);

      const resolved = await repo.transition(session, {
        from: "INCIDENT_ACTIVE",
        to: "RESOLVED",
        at: at(90),
        set: { endedAt: at(90).toISOString(), score: 900, ttdSeconds: 10, ttrSeconds: 70 },
      });
      expect(resolved).toMatchObject({ state: "RESOLVED", score: 900, ttrSeconds: 70 });
      expect(await repo.get(session)).toEqual(resolved);
    });

    it("refuses an illegal transition before touching storage", async () => {
      const session = newSession();
      await repo.create(session);
      await expect(
        repo.transition(session, { from: "STARTING", to: "RESOLVED", at: at(1) }),
      ).rejects.toThrow("illegal");
    });

    it("rejects a transition on a missing session", async () => {
      await expect(
        repo.transition(
          { userId, sessionId: ulid() },
          { from: "STARTING", to: "FAILED", at: at(1) },
        ),
      ).rejects.toBeInstanceOf(SessionStateConflict);
    });

    it("records the first acknowledge after the fault only", async () => {
      const starting = newSession();
      await repo.create(starting);
      expect(await repo.markAcknowledged(starting, at(5))).toBe(false);

      const active = newSession("INCIDENT_ACTIVE");
      await repo.create(active);
      expect(await repo.markAcknowledged(active, at(30))).toBe(true);
      expect(await repo.markAcknowledged(active, at(40))).toBe(false);
      expect((await repo.get(active))?.acknowledgedAt).toBe(at(30).toISOString());
    });

    it("records the first valid fix while active only", async () => {
      const active = newSession("INCIDENT_ACTIVE");
      await repo.create(active);
      expect(await repo.markValidFix(active, at(60))).toBe(true);
      expect(await repo.markValidFix(active, at(70))).toBe(false);
      expect((await repo.get(active))?.validFixAppliedAt).toBe(at(60).toISOString());

      await repo.transition(active, { from: "INCIDENT_ACTIVE", to: "FAILED", at: at(80) });
      const other = newSession("INCIDENT_ACTIVE");
      await repo.create(other);
      await repo.transition(other, { from: "INCIDENT_ACTIVE", to: "FAILED", at: at(80) });
      expect(await repo.markValidFix(other, at(90))).toBe(false);
    });

    it("adds to the counters atomically", async () => {
      const session = newSession("INCIDENT_ACTIVE");
      await repo.create(session);
      await Promise.all([
        repo.incrementCounters(session, { actions: 1, wrong: 1 }, at(30)),
        repo.incrementCounters(session, { actions: 1, wrong: 0 }, at(31)),
        repo.incrementCounters(session, { actions: 1, wrong: 1 }, at(32)),
      ]);
      expect(await repo.get(session)).toMatchObject({ actionsCount: 3, wrongActions: 2 });
    });

    it("finds the newest active session", async () => {
      const older = newSession();
      await repo.create(older);
      const newer = newSession("INCIDENT_ACTIVE");
      await repo.create(newer);
      const done = newSession();
      await repo.create(done);
      await repo.transition(done, { from: "STARTING", to: "FAILED", at: at(1) });

      const active = await repo.findActive();
      expect(active && active.sessionId >= newer.sessionId).toBe(true);
      expect(active?.state === "STARTING" || active?.state === "INCIDENT_ACTIVE").toBe(true);
    });
  });
}
