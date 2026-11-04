import { readFileSync } from "node:fs";
import { type Scenario, ScenarioSchema } from "../modules/scenarios/index.js";

/** The real `scenarios/orders-down.json`, so tests break if the shipped scenario does. */
export function ordersDownScenario(): Scenario {
  const url = new URL("../../scenarios/orders-down.json", import.meta.url);
  return ScenarioSchema.parse(JSON.parse(readFileSync(url, "utf8")));
}
