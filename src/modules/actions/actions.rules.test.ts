import { describe, expect, it } from "vitest";
import type { SessionState } from "../sessions/index.js";
import { checkActionAllowed, isPenalized, isValidFix } from "./actions.rules.js";
import type { ActionRequest } from "./actions.schemas.js";

const scenario = {
  availableActions: ["ACKNOWLEDGE", "VIEW_LOGS", "RESTART_DEPLOYMENT", "SCALE_DEPLOYMENT"] as const,
  targets: ["gateway", "orders", "worker-svc"],
  validFixes: [{ type: "SCALE_DEPLOYMENT" as const, target: "orders", minReplicas: 1 }],
};
const scenarioWith = { ...scenario, availableActions: [...scenario.availableActions] };

const ack: ActionRequest = { type: "ACKNOWLEDGE" };
const restart = (target: string): ActionRequest => ({ type: "RESTART_DEPLOYMENT", target });
const scale = (target: string, replicas: number): ActionRequest => ({
  type: "SCALE_DEPLOYMENT",
  target,
  params: { replicas },
});
const session = (state: SessionState) => ({ state });

describe("checkActionAllowed", () => {
  it("allows a listed action on a listed target while the incident is active", () => {
    expect(
      checkActionAllowed(scenarioWith, session("INCIDENT_ACTIVE"), scale("orders", 2)),
    ).toEqual({
      allowed: true,
    });
  });

  it("rejects an action type the scenario doesn't offer with ACTION_NOT_ALLOWED", () => {
    const limited = { ...scenarioWith, availableActions: ["ACKNOWLEDGE" as const] };
    expect(
      checkActionAllowed(limited, session("INCIDENT_ACTIVE"), restart("orders")),
    ).toMatchObject({
      allowed: false,
      reason: "ACTION_NOT_ALLOWED",
    });
  });

  it("rejects a target outside the scenario with ACTION_NOT_ALLOWED", () => {
    expect(
      checkActionAllowed(scenarioWith, session("INCIDENT_ACTIVE"), restart("kube-dns")),
    ).toMatchObject({ allowed: false, reason: "ACTION_NOT_ALLOWED" });
  });

  it.each(["STARTING", "RESOLVED", "FAILED"] as const)(
    "rejects a fix while %s with SESSION_NOT_ACTIVE",
    (state) => {
      expect(checkActionAllowed(scenarioWith, session(state), scale("orders", 2))).toMatchObject({
        allowed: false,
        reason: "SESSION_NOT_ACTIVE",
      });
    },
  );

  it.each(["STARTING", "INCIDENT_ACTIVE"] as const)("allows ACKNOWLEDGE while %s", (state) => {
    expect(checkActionAllowed(scenarioWith, session(state), ack)).toEqual({ allowed: true });
  });

  it.each(["RESOLVED", "FAILED"] as const)("rejects ACKNOWLEDGE once %s", (state) => {
    expect(checkActionAllowed(scenarioWith, session(state), ack)).toMatchObject({
      reason: "SESSION_NOT_ACTIVE",
    });
  });

  it("checks the scenario before the session state", () => {
    expect(
      checkActionAllowed(scenarioWith, session("RESOLVED"), restart("kube-dns")),
    ).toMatchObject({
      reason: "ACTION_NOT_ALLOWED",
    });
  });
});

describe("isValidFix", () => {
  it.each([
    [scale("orders", 1), true],
    [scale("orders", 3), true],
    [scale("gateway", 2), false],
    [restart("orders"), false],
    [{ type: "ACKNOWLEDGE" } as const, false],
  ])("%j → %s", (action, expected) => {
    expect(isValidFix(scenario, action)).toBe(expected);
  });

  it("rejects a scale below minReplicas", () => {
    const strict = {
      validFixes: [{ type: "SCALE_DEPLOYMENT" as const, target: "orders", minReplicas: 2 }],
    };
    expect(isValidFix(strict, scale("orders", 1))).toBe(false);
    expect(isValidFix(strict, scale("orders", 2))).toBe(true);
  });

  it("accepts a restart when the scenario lists it", () => {
    const restartFix = { validFixes: [{ type: "RESTART_DEPLOYMENT" as const, target: "orders" }] };
    expect(isValidFix(restartFix, restart("orders"))).toBe(true);
    expect(isValidFix(restartFix, restart("gateway"))).toBe(false);
  });
});

describe("isPenalized", () => {
  it.each([
    [{ type: "ACKNOWLEDGE" } as const, false],
    [{ type: "VIEW_LOGS" } as const, false],
    [{ type: "RESTART_DEPLOYMENT", target: "orders" } as const, true],
    [{ type: "SCALE_DEPLOYMENT", target: "orders", params: { replicas: 2 } } as const, true],
  ])("%j → %s", (action, expected) => {
    expect(isPenalized(action)).toBe(expected);
  });
});
