import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
  BEARER_AUTH,
  errorResponses,
  IsoDateTimeSchema,
  jsonContent,
  UlidSchema,
} from "../../openapi/registry.js";
import { SessionStateSchema } from "../sessions/index.js";

/** The named stats the SPA charts (ARCHITECTURE §6, D-36: computed from DynamoDB). */
export const StatsQueryNameSchema = z
  .enum(["score-over-time", "ttd-ttr-by-attempt"])
  .meta({ id: "StatsQueryName" });
export type StatsQueryName = z.infer<typeof StatsQueryNameSchema>;

export const StatsParamsSchema = z.object({ queryName: StatsQueryNameSchema });

const attemptFields = {
  /** 1 = the user's first ended session. */
  attempt: z.int().min(1),
  sessionId: UlidSchema,
  scenarioId: z.string(),
  endedAt: IsoDateTimeSchema,
};

export const ScoreRowSchema = z
  .object({ ...attemptFields, state: SessionStateSchema, score: z.number() })
  .meta({ id: "ScoreRow" });
export type ScoreRow = z.infer<typeof ScoreRowSchema>;

export const TtdTtrRowSchema = z
  .object({
    ...attemptFields,
    state: SessionStateSchema,
    /** Null when the user never acknowledged. */
    ttdSeconds: z.int().nullable(),
    /** Null when the session wasn't resolved. */
    ttrSeconds: z.int().nullable(),
  })
  .meta({ id: "TtdTtrRow" });
export type TtdTtrRow = z.infer<typeof TtdTtrRowSchema>;

export const StatsResponseSchema = z
  .discriminatedUnion("query", [
    z.object({ query: z.literal("score-over-time"), rows: z.array(ScoreRowSchema) }),
    z.object({ query: z.literal("ttd-ttr-by-attempt"), rows: z.array(TtdTtrRowSchema) }),
  ])
  .meta({ id: "StatsResponse" });
export type StatsResponse = z.infer<typeof StatsResponseSchema>;

export function registerStatsOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: "get",
    path: "/api/me/stats/{queryName}",
    tags: ["stats"],
    summary: "One of the caller's performance stats, oldest attempt first",
    description:
      "`score-over-time`: score of every ended attempt. `ttd-ttr-by-attempt`: time to detect and to resolve per ended attempt. Only the caller's sessions (D-36).",
    security: [{ [BEARER_AUTH]: [] }],
    request: { params: StatsParamsSchema },
    responses: {
      200: { description: "Rows for the chart", ...jsonContent(StatsResponseSchema) },
      ...errorResponses(400, 401),
    },
  });
}
