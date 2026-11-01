import type { Scenario } from "../scenarios/index.js";
import type { SessionState } from "../sessions/index.js";
import type { ActionRequest } from "./actions.schemas.js";

export type ActionCheck =
  | { allowed: true }
  | { allowed: false; reason: "ACTION_NOT_ALLOWED" | "SESSION_NOT_ACTIVE"; message: string };

/**
 * ARCHITECTURE §5: the type must be in `availableActions`, the target in `targets`, and the
 * session `INCIDENT_ACTIVE` (`ACKNOWLEDGE` is also allowed while `STARTING`).
 * `ACTION_NOT_ALLOWED` → 422, `SESSION_NOT_ACTIVE` → 409.
 */
export function checkActionAllowed(
  scenario: Pick<Scenario, "availableActions" | "targets">,
  session: { state: SessionState },
  action: ActionRequest,
): ActionCheck {
  if (!scenario.availableActions.includes(action.type)) {
    return deny("ACTION_NOT_ALLOWED", `${action.type} is not available in this scenario.`);
  }
  if ("target" in action && !scenario.targets.includes(action.target)) {
    return deny("ACTION_NOT_ALLOWED", `${action.target} is not a target in this scenario.`);
  }
  const activeStates: SessionState[] =
    action.type === "ACKNOWLEDGE" ? ["STARTING", "INCIDENT_ACTIVE"] : ["INCIDENT_ACTIVE"];
  if (!activeStates.includes(session.state)) {
    return deny("SESSION_NOT_ACTIVE", `The session is ${session.state}.`);
  }
  return { allowed: true };
}

function deny(reason: "ACTION_NOT_ALLOWED" | "SESSION_NOT_ACTIVE", message: string): ActionCheck {
  return { allowed: false, reason, message };
}

type AppliedAction =
  | { type: "ACKNOWLEDGE" | "VIEW_LOGS" }
  | { type: "RESTART_DEPLOYMENT"; target: string }
  | { type: "SCALE_DEPLOYMENT"; target: string; params: { replicas: number } };

/** Same type and target as a `validFixes` entry; for scale, `replicas >= minReplicas`. */
export function isValidFix(scenario: Pick<Scenario, "validFixes">, action: AppliedAction): boolean {
  return scenario.validFixes.some((fix) => {
    if (fix.type !== action.type || !("target" in action) || fix.target !== action.target) {
      return false;
    }
    if (fix.type === "SCALE_DEPLOYMENT" && action.type === "SCALE_DEPLOYMENT") {
      return action.params.replicas >= fix.minReplicas;
    }
    return true;
  });
}

/** Wrong actions cost points; looking (ACKNOWLEDGE, VIEW_LOGS) never does. */
export function isPenalized(action: AppliedAction): boolean {
  return action.type !== "ACKNOWLEDGE" && action.type !== "VIEW_LOGS";
}
