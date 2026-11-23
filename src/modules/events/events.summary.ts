import type { EventLine } from "./events.schemas.js";

const ACTION_LABELS: Record<string, string> = {
  RESTART_DEPLOYMENT: "Restarted",
  SCALE_DEPLOYMENT: "Scaled",
};

/** One line for the dashboard's `recentEvents[].summary` (BE-072). Pure. */
export function summarizeEvent(event: EventLine): string {
  const target = event.target ?? "the system";
  switch (event.type) {
    case "SESSION_STARTED":
      return "Session started";
    case "FAULT_INJECTED":
      return "Incident started";
    case "ACKNOWLEDGED":
      return "Incident acknowledged";
    case "VIEW_LOGS":
      return `Viewed logs of ${target}`;
    case "ACTION": {
      const label = (event.action && ACTION_LABELS[event.action]) ?? event.action ?? "Action on";
      const replicas = event.params ? ` to ${event.params.replicas}` : "";
      const verdict = event.valid === false ? " (no effect on the incident)" : "";
      return `${label} ${target}${replicas}${verdict}`;
    }
    case "RESOLVED":
      return "Incident resolved";
    case "SCORED":
      return event.score === null ? "Scored" : `Scored ${event.score}`;
    case "FAILED":
      return "Session failed";
  }
}
