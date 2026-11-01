import { type Clock, systemClock } from "../../platform/clock.js";
import type {
  DeploymentStatus,
  Fault,
  HealthCheckResult,
  MockClusterGateway,
  PodStatus,
} from "./mock-cluster.gateway.js";

/** The infra mock system's health chain (infra D-17): `/health` reflects downstream services. */
export const MOCK_SYSTEM_DEPENDENCIES: Record<string, string[]> = {
  gateway: ["orders"],
  orders: ["worker-svc"],
};

type FakeDeployment = { replicas: number; generation: number; startedAt: string };

/** Runs `fn` so that a throw becomes a rejected promise, like a real API call. */
function run<T>(fn: () => T): Promise<T> {
  return new Promise((resolve) => resolve(fn()));
}

export type FakeMockCluster = MockClusterGateway & {
  /** Breaks the fake like the injector would (used by dev-inject and tests). */
  applyFault(fault: Fault): void;
  /** Back to the scenario baseline. */
  reset(): void;
};

/**
 * In-memory mock system for local dev, frontend work and tests (`MOCK_CLUSTER=fake`).
 * Changes take effect immediately; a deployment with 0 ready replicas is unhealthy, and so is
 * anything that depends on it.
 */
export function createFakeMockCluster(options: {
  baseline: Record<string, number>;
  dependencies?: Record<string, string[]>;
  clock?: Clock;
}): FakeMockCluster {
  const clock = options.clock ?? systemClock;
  const dependencies = options.dependencies ?? MOCK_SYSTEM_DEPENDENCIES;
  const deployments = new Map<string, FakeDeployment>();

  const reset = () => {
    deployments.clear();
    for (const [name, replicas] of Object.entries(options.baseline)) {
      deployments.set(name, { replicas, generation: 0, startedAt: clock.now().toISOString() });
    }
  };
  reset();

  const get = (name: string): FakeDeployment => {
    const deployment = deployments.get(name);
    if (!deployment) throw new Error(`deployment ${name} not found in the fake mock cluster`);
    return deployment;
  };

  const isUp = (name: string, seen = new Set<string>()): boolean => {
    if (seen.has(name)) return true;
    seen.add(name);
    const deployment = deployments.get(name);
    if (!deployment || deployment.replicas === 0) return false;
    return (dependencies[name] ?? []).every((dependency) => isUp(dependency, seen));
  };

  const restartPods = (deployment: FakeDeployment) => {
    deployment.generation += 1;
    deployment.startedAt = clock.now().toISOString();
  };

  return {
    listDeployments: () =>
      Promise.resolve(
        [...deployments].map(([name, d]): DeploymentStatus => ({
          name,
          desiredReplicas: d.replicas,
          readyReplicas: d.replicas,
        })),
      ),
    listPods: () =>
      Promise.resolve(
        [...deployments].flatMap(([name, d]) =>
          Array.from({ length: d.replicas }, (_, i): PodStatus => ({
            name: `${name}-fake${d.generation}-${i}`,
            deployment: name,
            phase: "Running",
            ready: true,
            restarts: 0,
            startedAt: d.startedAt,
          })),
        ),
      ),
    readLogs: (service, tailLines) =>
      run(() => {
        if (get(service).replicas === 0) return [];
        const lines = isUp(service)
          ? [`level=info service=${service} msg="request handled" status=200`]
          : [`level=error service=${service} msg="upstream unavailable" status=503`];
        return lines.slice(-tailLines);
      }),
    scale: (name, replicas) =>
      run(() => {
        const deployment = get(name);
        if (deployment.replicas === 0 && replicas > 0) restartPods(deployment);
        deployment.replicas = replicas;
      }),
    restart: (name) => run(() => restartPods(get(name))),
    checkHealth: (service): Promise<HealthCheckResult> =>
      Promise.resolve(isUp(service) ? { healthy: true, latencyMs: 5 } : { healthy: false }),
    applyFault: (fault) => {
      const deployment = get(fault.target);
      if (fault.type === "SCALE_TO_ZERO") deployment.replicas = 0;
      else restartPods(deployment);
    },
    reset,
  };
}
