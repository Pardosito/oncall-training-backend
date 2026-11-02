import type { FaultType } from "../scenarios/index.js";

/** Plain domain types: no Kubernetes client types cross this boundary (BE-074). */
export type DeploymentStatus = {
  name: string;
  desiredReplicas: number;
  readyReplicas: number;
};

export type PodStatus = {
  name: string;
  /** Deployment the pod belongs to (from its `app` label). */
  deployment: string;
  phase: string;
  ready: boolean;
  restarts: number;
  startedAt?: string;
};

export type HealthCheckResult = { healthy: boolean; latencyMs?: number };

/**
 * Gateway to the mock system in namespace `MOCK_NAMESPACE`. Callers must check names against
 * the scenario's `targets` first (CONVENTIONS §9). Implementations: Kubernetes and an in-memory fake.
 */
export type MockClusterGateway = {
  listDeployments(): Promise<DeploymentStatus[]>;
  listPods(): Promise<PodStatus[]>;
  readLogs(service: string, tailLines: number): Promise<string[]>;
  scale(deployment: string, replicas: number): Promise<void>;
  restart(deployment: string): Promise<void>;
  checkHealth(service: string): Promise<HealthCheckResult>;
};

export type Fault = { type: FaultType; target: string };
