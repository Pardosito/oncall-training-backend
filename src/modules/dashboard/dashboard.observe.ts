import type {
  DeploymentStatus,
  HealthCheckResult,
  MockClusterGateway,
  PodStatus,
} from "../mock-cluster/index.js";
import { serviceHealth } from "./dashboard.builder.js";

export type MockSystemObservation = {
  deployments: DeploymentStatus[];
  pods: PodStatus[];
  health: Record<string, HealthCheckResult>;
};

/** One read of the mock system for the given targets: deployments, pods and health checks in parallel. */
export async function observeMockSystem(
  cluster: MockClusterGateway,
  targets: readonly string[],
): Promise<MockSystemObservation> {
  const [deployments, pods, checks] = await Promise.all([
    cluster.listDeployments(),
    cluster.listPods(),
    Promise.all(targets.map((target) => cluster.checkHealth(target))),
  ]);
  const health = Object.fromEntries(
    targets.map((target, i) => [target, checks[i] ?? { healthy: false }]),
  );
  return { deployments, pods, health };
}

/**
 * What resolution means by "every service healthy" (D-07): each target has a ready replica and
 * answers its health check. `degraded` (slow or partly scaled) still counts, so a slow check
 * can't block resolution forever.
 */
export function allServicesUp(
  observation: MockSystemObservation,
  targets: readonly string[],
): boolean {
  return targets.every((target) => {
    const deployment = observation.deployments.find((d) => d.name === target);
    return serviceHealth(deployment, observation.health[target]) !== "down";
  });
}
