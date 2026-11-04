import {
  AppsV1Api,
  CoreV1Api,
  KubeConfig,
  PatchStrategy,
  setHeaderOptions,
  type V1Deployment,
  type V1Pod,
} from "@kubernetes/client-node";
import type {
  DeploymentStatus,
  HealthCheckResult,
  MockClusterGateway,
  PodStatus,
} from "./mock-cluster.gateway.js";

/** Label every mock-system pod carries (infra ARCHITECTURE §5). */
export const DEPLOYMENT_LABEL = "app.kubernetes.io/name";
export const RESTARTED_AT_ANNOTATION = "kubectl.kubernetes.io/restartedAt";

/** The slice of the client this gateway calls; tests pass stubs. */
export type KubeApis = {
  apps: Pick<
    AppsV1Api,
    "listNamespacedDeployment" | "patchNamespacedDeployment" | "patchNamespacedDeploymentScale"
  >;
  core: Pick<CoreV1Api, "listNamespacedPod" | "readNamespacedPodLog">;
};

/** In EKS: the pod's ServiceAccount; locally: `~/.kube/config` (kind). */
export function loadKubeApis(): KubeApis {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  return { apps: kc.makeApiClient(AppsV1Api), core: kc.makeApiClient(CoreV1Api) };
}

const mergePatch = setHeaderOptions("Content-Type", PatchStrategy.MergePatch);

export function toDeploymentStatus(deployment: V1Deployment): DeploymentStatus {
  return {
    name: deployment.metadata?.name ?? "",
    desiredReplicas: deployment.spec?.replicas ?? 0,
    readyReplicas: deployment.status?.readyReplicas ?? 0,
  };
}

export function toPodStatus(pod: V1Pod): PodStatus {
  const ready = pod.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True");
  const restarts = (pod.status?.containerStatuses ?? []).reduce((n, c) => n + c.restartCount, 0);
  return {
    name: pod.metadata?.name ?? "",
    deployment: pod.metadata?.labels?.[DEPLOYMENT_LABEL] ?? "",
    phase: pod.metadata?.deletionTimestamp ? "Terminating" : (pod.status?.phase ?? "Unknown"),
    ready: ready ?? false,
    restarts,
    startedAt: pod.status?.startTime ? new Date(pod.status.startTime).toISOString() : undefined,
  };
}

/**
 * Reads and fixes the mock system with namespaced calls only (CONVENTIONS §9). Every call maps
 * to an RBAC rule in ARCHITECTURE §8.6: list deployments/pods, get pods/log, patch
 * deployments and deployments/scale. Names must already be checked against the scenario.
 */
export function createKubernetesMockCluster(deps: {
  namespace: string;
  checkHealth: (service: string) => Promise<HealthCheckResult>;
  apis?: KubeApis;
  now?: () => Date;
}): MockClusterGateway {
  const { namespace } = deps;
  const apis = deps.apis ?? loadKubeApis();
  const now = deps.now ?? (() => new Date());

  async function podsOf(deployment?: string): Promise<V1Pod[]> {
    const list = await apis.core.listNamespacedPod({
      namespace,
      labelSelector: deployment ? `${DEPLOYMENT_LABEL}=${deployment}` : DEPLOYMENT_LABEL,
    });
    return list.items;
  }

  return {
    async listDeployments() {
      const list = await apis.apps.listNamespacedDeployment({ namespace });
      return list.items.map(toDeploymentStatus);
    },

    async listPods() {
      return (await podsOf()).map(toPodStatus);
    },

    async readLogs(service, tailLines) {
      // Newest running pod first; a crashed or terminating pod has nothing useful to say.
      const pods = (await podsOf(service))
        .map((pod) => ({ pod, status: toPodStatus(pod) }))
        .sort((a, b) => (b.status.startedAt ?? "").localeCompare(a.status.startedAt ?? ""));
      const target = pods.find((p) => p.status.phase === "Running") ?? pods[0];
      if (!target) return [];
      const text = await apis.core.readNamespacedPodLog({
        name: target.status.name,
        namespace,
        tailLines,
      });
      return text.split("\n").filter((line) => line.length > 0);
    },

    async scale(deployment, replicas) {
      await apis.apps.patchNamespacedDeploymentScale(
        { name: deployment, namespace, body: { spec: { replicas } } },
        mergePatch,
      );
    },

    async restart(deployment) {
      const annotations = { [RESTARTED_AT_ANNOTATION]: now().toISOString() };
      await apis.apps.patchNamespacedDeployment(
        {
          name: deployment,
          namespace,
          body: { spec: { template: { metadata: { annotations } } } },
        },
        mergePatch,
      );
    },

    checkHealth: (service) => deps.checkHealth(service),
  };
}
