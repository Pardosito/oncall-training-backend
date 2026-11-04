import type { Logger } from "../platform/logger.js";
import type { MockClusterGateway } from "../modules/mock-cluster/index.js";
import type { Scenario } from "../modules/scenarios/index.js";

/**
 * Scales every deployment back to the scenario baseline (patch on `deployments/scale` only,
 * which mock-operator allows). Tries all of them, then throws if any failed; scaling is idempotent.
 */
export async function resetToBaseline(
  cluster: MockClusterGateway,
  scenario: Pick<Scenario, "baseline">,
  log: Logger,
): Promise<void> {
  const failures: string[] = [];
  for (const [deployment, replicas] of Object.entries(scenario.baseline)) {
    try {
      await cluster.scale(deployment, replicas);
    } catch (error) {
      failures.push(deployment);
      log.error({ err: error, deployment }, "could not reset deployment to baseline");
    }
  }
  if (failures.length > 0) throw new Error(`reset failed for ${failures.join(", ")}`);
}
