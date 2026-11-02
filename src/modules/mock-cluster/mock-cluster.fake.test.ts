import { describe, expect, it } from "vitest";
import { createFixedClock } from "../../platform/clock.js";
import { createFakeMockCluster } from "./mock-cluster.fake.js";

const baseline = { gateway: 1, orders: 2, "worker-svc": 1 };

describe("createFakeMockCluster", () => {
  it("starts from the baseline, healthy", async () => {
    const cluster = createFakeMockCluster({ baseline });

    expect(await cluster.listDeployments()).toEqual([
      { name: "gateway", desiredReplicas: 1, readyReplicas: 1 },
      { name: "orders", desiredReplicas: 2, readyReplicas: 2 },
      { name: "worker-svc", desiredReplicas: 1, readyReplicas: 1 },
    ]);
    expect(await cluster.listPods()).toHaveLength(4);
    expect(await cluster.checkHealth("gateway")).toEqual({ healthy: true, latencyMs: 5 });
  });

  it("SCALE_TO_ZERO takes the target down, and its dependents with it", async () => {
    const cluster = createFakeMockCluster({ baseline });

    cluster.applyFault({ type: "SCALE_TO_ZERO", target: "orders" });

    expect(await cluster.checkHealth("orders")).toEqual({ healthy: false });
    expect(await cluster.checkHealth("gateway")).toEqual({ healthy: false });
    expect((await cluster.checkHealth("worker-svc")).healthy).toBe(true);
    expect((await cluster.listPods()).filter((pod) => pod.deployment === "orders")).toEqual([]);
    expect(await cluster.readLogs("orders", 100)).toEqual([]);
  });

  it("scaling back up revives the target with new pods", async () => {
    const clock = createFixedClock("2026-11-05T18:00:00.000Z");
    const cluster = createFakeMockCluster({ baseline, clock });
    cluster.applyFault({ type: "SCALE_TO_ZERO", target: "orders" });
    clock.advance(60);

    await cluster.scale("orders", 2);

    expect((await cluster.checkHealth("gateway")).healthy).toBe(true);
    const pods = (await cluster.listPods()).filter((pod) => pod.deployment === "orders");
    expect(pods).toHaveLength(2);
    expect(pods[0]?.startedAt).toBe("2026-11-05T18:01:00.000Z");
  });

  it("restart replaces the pods and keeps the replica count", async () => {
    const cluster = createFakeMockCluster({ baseline });
    const before = (await cluster.listPods()).map((pod) => pod.name);

    await cluster.restart("orders");

    const after = (await cluster.listPods()).map((pod) => pod.name);
    expect(after).toHaveLength(before.length);
    expect(after.filter((name) => name.startsWith("orders"))).not.toEqual(
      before.filter((name) => name.startsWith("orders")),
    );
  });

  it("reset restores the baseline", async () => {
    const cluster = createFakeMockCluster({ baseline });
    cluster.applyFault({ type: "SCALE_TO_ZERO", target: "orders" });

    cluster.reset();

    expect((await cluster.checkHealth("gateway")).healthy).toBe(true);
  });

  it("refuses deployments outside the baseline", async () => {
    const cluster = createFakeMockCluster({ baseline });
    await expect(cluster.scale("kube-dns", 1)).rejects.toThrow("not found");
  });
});
