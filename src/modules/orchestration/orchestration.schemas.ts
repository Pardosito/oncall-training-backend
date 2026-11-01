import { z } from "zod";
import { IsoDateTimeSchema, UlidSchema } from "../../openapi/registry.js";
import { FaultTypeSchema } from "../scenarios/index.js";

/**
 * `FAULT` message on the `faults` queue (infra ARCHITECTURE §7, decision P-05). Infra's shape wins:
 * the injector's record step (D-12) needs `userId` and `sessionId`. In the Nov 5 MVP the api sends
 * it directly (BE-128); from M2 the state machine does.
 */
export const FaultMessageSchema = z.object({
  faultId: UlidSchema,
  sessionId: UlidSchema,
  userId: z.string().min(1),
  type: FaultTypeSchema,
  target: z.object({ namespace: z.string().min(1), deployment: z.string().min(1) }),
  sentAt: IsoDateTimeSchema,
});
export type FaultMessage = z.infer<typeof FaultMessageSchema>;
