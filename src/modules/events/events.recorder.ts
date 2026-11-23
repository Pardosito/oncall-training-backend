import type { Logger } from "../../platform/logger.js";
import type { EventLog } from "./events.log.js";
import { buildEvent, type EventInput } from "./events.schemas.js";

/**
 * What the api and the worker call when something happens in a session (D-20). Best effort: the
 * event log feeds the dashboard and the charts, so a Redis error is logged and never fails the
 * action, the start or the resolution that caused it.
 */
export type EventRecorder = { record(input: EventInput): Promise<void> };

export function createEventRecorder(deps: { events: EventLog; logger: Logger }): EventRecorder {
  return {
    async record(input) {
      try {
        await deps.events.append(input.sessionId, buildEvent(input));
      } catch (error) {
        deps.logger.warn(
          { err: error, sessionId: input.sessionId, type: input.type },
          "could not record the event",
        );
      }
    },
  };
}
