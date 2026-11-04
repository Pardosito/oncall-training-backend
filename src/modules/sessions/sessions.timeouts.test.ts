import { describe, expect, it } from "vitest";
import { makeSession } from "../../test-support/sessions.js";
import { latestEndOf, STARTING_GRACE_SECONDS, timeoutOf } from "./sessions.timeouts.js";

const scenario = { warmupSeconds: 20, maxResolveSeconds: 600 };
const created = "2026-11-05T18:00:00.000Z";
const plus = (s: number) => new Date(Date.parse(created) + s * 1000);

describe("timeoutOf", () => {
  it("fails a STARTING session with ERROR after warmup + grace", () => {
    expect(timeoutOf(makeSession({ createdAt: created }), scenario)).toEqual({
      at: plus(20 + STARTING_GRACE_SECONDS),
      reason: "ERROR",
    });
  });

  it("fails an active session with TIMEOUT maxResolveSeconds after the fault", () => {
    const session = makeSession({
      state: "INCIDENT_ACTIVE",
      createdAt: created,
      faultInjectedAt: plus(25).toISOString(),
    });
    expect(timeoutOf(session, scenario)).toEqual({ at: plus(625), reason: "TIMEOUT" });
  });

  it("has no timeout once terminal", () => {
    expect(timeoutOf(makeSession({ state: "RESOLVED" }), scenario)).toBeUndefined();
  });
});

describe("latestEndOf", () => {
  it("covers warmup, grace and the full resolve window while STARTING", () => {
    expect(latestEndOf(makeSession({ createdAt: created }), scenario)).toEqual(
      plus(20 + STARTING_GRACE_SECONDS + 600),
    );
  });
});
