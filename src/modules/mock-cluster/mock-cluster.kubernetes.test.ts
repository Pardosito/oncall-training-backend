import type { V1Deployment, V1Pod } from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";
import {
  createKubernetesMockCluster,
  DEPLOYMENT_LABEL,
  type KubeApis,
  RESTARTED_AT_ANNOTATION,
  toPodStatus,
} from "./mock-cluster.kubernetes.js";

function pod(name: string, deployment: string, overrides: Partial<V1Pod["status"]> = {}): V1Pod {
  return {
    metadata: { name, labels: { [DEPLOYMENT_LABEL]: deployment } },
    status: {
      phase: "Running",
      startTime: new Date("2026-11-05T18:00:00Z"),
      conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [
        { name: "app", restartCount: 2, image: "i", imageID: "", ready: true },
      ] as NonNullable<V1Pod["status"]>["containerStatuses"],
      ...overrides,
    },
  };
}

function stubApis(pods: V1Pod[] = [], deployments: V1Deployment[] = []) {
  const apps = {
    listNamespacedDeployment: vi.fn().mockResolvedValue({ items: deployments }),
    patchNamespacedDeployment: vi.fn().mockResolvedValue({}),
    patchNamespacedDeploymentScale: vi.fn().mockResolvedValue({}),
  };
  const core = {
    listNamespacedPod: vi.fn().mockResolvedValue({ items: pods }),
    readNamespacedPodLog: vi.fn().mockResolvedValue("line 1\nline 2\n"),
  };
  return { apis: { apps, core } as unknown as KubeApis, apps, core };
}

const healthy = () => Promise.resolve({ healthy: true, latencyMs: 5 });
const now = () => new Date("2026-11-05T18:05:00.000Z");

describe("toPodStatus", () => {
  it("maps readiness, restarts, deployment label and start time", () => {
    expect(toPodStatus(pod("orders-1", "orders"))).toEqual({
      name: "orders-1",
      deployment: "orders",
      phase: "Running",
      ready: true,
      restarts: 2,
      startedAt: "2026-11-05T18:00:00.000Z",
    });
  });

  it("reports terminating pods and missing readiness", () => {
    const p = pod("orders-1", "orders", { conditions: [{ type: "Ready", status: "False" }] });
    p.metadata = { ...p.metadata, deletionTimestamp: new Date() };
    expect(toPodStatus(p)).toMatchObject({ phase: "Terminating", ready: false });
  });
});

describe("createKubernetesMockCluster", () => {
  it("lists deployments and pods in the mock namespace only", async () => {
    const stub = stubApis(
      [pod("orders-1", "orders")],
      [
        {
          metadata: { name: "orders" },
          spec: { replicas: 2, selector: {}, template: {} },
          status: { readyReplicas: 1 },
        },
      ],
    );
    const gateway = createKubernetesMockCluster({
      namespace: "mock",
      checkHealth: healthy,
      apis: stub.apis,
    });

    expect(await gateway.listDeployments()).toEqual([
      { name: "orders", desiredReplicas: 2, readyReplicas: 1 },
    ]);
    expect(await gateway.listPods()).toHaveLength(1);
    expect(stub.apps.listNamespacedDeployment).toHaveBeenCalledWith({ namespace: "mock" });
    expect(stub.core.listNamespacedPod).toHaveBeenCalledWith({
      namespace: "mock",
      labelSelector: DEPLOYMENT_LABEL,
    });
  });

  it("scales with a merge patch on deployments/scale", async () => {
    const stub = stubApis();
    const gateway = createKubernetesMockCluster({
      namespace: "mock",
      checkHealth: healthy,
      apis: stub.apis,
    });

    await gateway.scale("orders", 2);

    expect(stub.apps.patchNamespacedDeploymentScale).toHaveBeenCalledWith(
      { name: "orders", namespace: "mock", body: { spec: { replicas: 2 } } },
      expect.anything(),
    );
  });

  it("restarts by patching the restartedAt annotation", async () => {
    const stub = stubApis();
    const gateway = createKubernetesMockCluster({
      namespace: "mock",
      checkHealth: healthy,
      apis: stub.apis,
      now,
    });

    await gateway.restart("orders");

    expect(stub.apps.patchNamespacedDeployment).toHaveBeenCalledWith(
      {
        name: "orders",
        namespace: "mock",
        body: {
          spec: {
            template: {
              metadata: { annotations: { [RESTARTED_AT_ANNOTATION]: "2026-11-05T18:05:00.000Z" } },
            },
          },
        },
      },
      expect.anything(),
    );
  });

  it("reads logs from the newest running pod of the deployment", async () => {
    const stub = stubApis([
      pod("orders-old", "orders", { startTime: new Date("2026-11-05T17:00:00Z") }),
      pod("orders-new", "orders", { startTime: new Date("2026-11-05T18:01:00Z") }),
      pod("orders-crash", "orders", {
        phase: "Pending",
        startTime: new Date("2026-11-05T18:02:00Z"),
      }),
    ]);
    const gateway = createKubernetesMockCluster({
      namespace: "mock",
      checkHealth: healthy,
      apis: stub.apis,
    });

    expect(await gateway.readLogs("orders", 100)).toEqual(["line 1", "line 2"]);
    expect(stub.core.listNamespacedPod).toHaveBeenCalledWith({
      namespace: "mock",
      labelSelector: `${DEPLOYMENT_LABEL}=orders`,
    });
    expect(stub.core.readNamespacedPodLog).toHaveBeenCalledWith({
      name: "orders-new",
      namespace: "mock",
      tailLines: 100,
    });
  });

  it("returns no logs when the deployment has no pods", async () => {
    const stub = stubApis([]);
    const gateway = createKubernetesMockCluster({
      namespace: "mock",
      checkHealth: healthy,
      apis: stub.apis,
    });
    expect(await gateway.readLogs("orders", 100)).toEqual([]);
    expect(stub.core.readNamespacedPodLog).not.toHaveBeenCalled();
  });
});
