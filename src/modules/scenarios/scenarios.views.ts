import type { Scenario, ScenarioPublic, ScenarioSummary } from "./scenarios.schemas.js";

export function toSummary(scenario: Scenario): ScenarioSummary {
  return {
    id: scenario.id,
    title: scenario.title,
    description: scenario.description,
    maxResolveSeconds: scenario.maxResolveSeconds,
  };
}

/** Builds the public view field by field, so a new internal field never leaks by default. */
export function toPublic(scenario: Scenario): ScenarioPublic {
  return {
    id: scenario.id,
    title: scenario.title,
    description: scenario.description,
    warmupSeconds: scenario.warmupSeconds,
    maxResolveSeconds: scenario.maxResolveSeconds,
    targets: [...scenario.targets],
    availableActions: [...scenario.availableActions],
    scoring: { ...scenario.scoring },
  };
}
