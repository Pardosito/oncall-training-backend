import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
  BEARER_AUTH,
  errorResponses,
  IsoDateTimeSchema,
  jsonContent,
} from "../../openapi/registry.js";

export const LeaderboardParamsSchema = z.object({ scenarioId: z.string().min(1) });
export const LeaderboardQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

/** One ranked attempt. Never carries another user's id; `isYou` marks the caller's rows. */
export const LeaderboardEntrySchema = z
  .object({
    rank: z.int().min(1),
    username: z.string(),
    score: z.number(),
    ttdSeconds: z.int().optional(),
    ttrSeconds: z.int().optional(),
    wrongActions: z.int(),
    endedAt: IsoDateTimeSchema.optional(),
    isYou: z.boolean(),
  })
  .meta({ id: "LeaderboardEntry" });
export type LeaderboardEntry = z.infer<typeof LeaderboardEntrySchema>;

export const LeaderboardResponseSchema = z
  .object({ scenarioId: z.string(), entries: z.array(LeaderboardEntrySchema) })
  .meta({ id: "LeaderboardResponse" });
export type LeaderboardResponse = z.infer<typeof LeaderboardResponseSchema>;

export function registerLeaderboardOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: "get",
    path: "/api/leaderboard/{scenarioId}",
    tags: ["leaderboard"],
    summary: "Top scores of a scenario (resolved attempts, every user)",
    description:
      "The only shared view (AGENTS §3): username and score, never user ids. Ties keep the GSI order.",
    security: [{ [BEARER_AUTH]: [] }],
    request: { params: LeaderboardParamsSchema, query: LeaderboardQuerySchema },
    responses: {
      200: { description: "Ranked entries", ...jsonContent(LeaderboardResponseSchema) },
      ...errorResponses(400, 401, 404),
    },
  });
}
