import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { BEARER_AUTH, errorResponses, jsonContent } from "../../openapi/registry.js";

/** Every action a scenario can offer (ARCHITECTURE §5). `ABANDON` is a route, not a panel action. */
export const ActionTypeSchema = z
  .enum(["ACKNOWLEDGE", "VIEW_LOGS", "RESTART_DEPLOYMENT", "SCALE_DEPLOYMENT"])
  .meta({ id: "ActionType" });
export type ActionType = z.infer<typeof ActionTypeSchema>;

/** Fault types the injector applies (infra ARCHITECTURE §7). */
export const FaultTypeSchema = z.enum(["SCALE_TO_ZERO", "DELETE_PODS"]);
export type FaultType = z.infer<typeof FaultTypeSchema>;

export const MIN_REPLICAS = 1;
export const MAX_REPLICAS = 3;
export const ReplicasSchema = z.int().min(MIN_REPLICAS).max(MAX_REPLICAS);

const ScenarioIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be kebab-case")
  .meta({ example: "orders-down" });
const DeploymentNameSchema = z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);

const ValidFixSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("RESTART_DEPLOYMENT"), target: DeploymentNameSchema }),
  z.object({
    type: z.literal("SCALE_DEPLOYMENT"),
    target: DeploymentNameSchema,
    minReplicas: ReplicasSchema,
  }),
]);
export type ValidFix = z.infer<typeof ValidFixSchema>;

const ScoringSchema = z
  .object({
    base: z.number().nonnegative(),
    perSecondTTD: z.number().nonnegative(),
    perSecondTTR: z.number().nonnegative(),
    perWrongAction: z.number().nonnegative(),
  })
  .meta({ id: "ScenarioScoring" });

/** A scripted incident (`scenarios/*.json`, ARCHITECTURE §7.5). Internal: contains the answer. */
export const ScenarioSchema = z
  .object({
    id: ScenarioIdSchema,
    title: z.string().min(1),
    description: z.string().min(1),
    warmupSeconds: z.int().min(0),
    maxResolveSeconds: z.int().positive(),
    targets: z.array(DeploymentNameSchema).min(1),
    baseline: z.record(DeploymentNameSchema, ReplicasSchema),
    faults: z.array(z.object({ type: FaultTypeSchema, target: DeploymentNameSchema })).min(1),
    availableActions: z.array(ActionTypeSchema).min(1),
    validFixes: z.array(ValidFixSchema).min(1),
    scoring: ScoringSchema,
  })
  .superRefine((scenario, ctx) => {
    const targets = new Set(scenario.targets);
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });

    if (targets.size !== scenario.targets.length) issue(["targets"], "targets must be unique");
    for (const key of Object.keys(scenario.baseline)) {
      if (!targets.has(key)) issue(["baseline", key], `baseline key "${key}" is not a target`);
    }
    scenario.faults.forEach((fault, i) => {
      if (!targets.has(fault.target))
        issue(["faults", i, "target"], "fault target is not a target");
    });
    scenario.validFixes.forEach((fix, i) => {
      if (!targets.has(fix.target))
        issue(["validFixes", i, "target"], "fix target is not a target");
      if (!scenario.availableActions.includes(fix.type)) {
        issue(["validFixes", i, "type"], `fix type ${fix.type} is not in availableActions`);
      }
    });
  });
export type Scenario = z.infer<typeof ScenarioSchema>;

/** List item for the scenario picker. */
export const ScenarioSummarySchema = z
  .object({
    id: ScenarioIdSchema,
    title: z.string(),
    description: z.string(),
    maxResolveSeconds: z.int(),
  })
  .meta({ id: "ScenarioSummary" });
export type ScenarioSummary = z.infer<typeof ScenarioSummarySchema>;

/**
 * What a user may see before and during a session. Leaves out `validFixes`, `faults` and
 * `baseline`, which give away the answer (ARCHITECTURE §6).
 */
export const ScenarioPublicSchema = z
  .object({
    id: ScenarioIdSchema,
    title: z.string(),
    description: z.string(),
    warmupSeconds: z.int(),
    maxResolveSeconds: z.int(),
    targets: z.array(z.string()),
    availableActions: z.array(ActionTypeSchema),
    scoring: ScoringSchema,
  })
  .meta({ id: "ScenarioPublic" });
export type ScenarioPublic = z.infer<typeof ScenarioPublicSchema>;

export const ScenarioParamsSchema = z.object({ scenarioId: ScenarioIdSchema });

export function registerScenariosOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: "get",
    path: "/api/scenarios",
    tags: ["scenarios"],
    summary: "List scenarios",
    security: [{ [BEARER_AUTH]: [] }],
    responses: {
      200: { description: "Scenario list", ...jsonContent(z.array(ScenarioSummarySchema)) },
      ...errorResponses(401),
    },
  });
  registry.registerPath({
    method: "get",
    path: "/api/scenarios/{scenarioId}",
    tags: ["scenarios"],
    summary: "Get a scenario (public view, no answer)",
    security: [{ [BEARER_AUTH]: [] }],
    request: { params: ScenarioParamsSchema },
    responses: {
      200: { description: "Scenario", ...jsonContent(ScenarioPublicSchema) },
      ...errorResponses(401, 404),
    },
  });
}
