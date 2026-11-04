import { describe, expect, it, vi } from "vitest";
import { createHttpHealthChecker } from "./mock-cluster.health.js";

const template = "http://{service}.mock.svc.cluster.local:8080/health";

describe("createHttpHealthChecker", () => {
  it("is healthy on 2xx and reports the latency", async () => {
    const fetchStub = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok", { status: 200 }));
    let t = 0;
    const check = createHttpHealthChecker({
      urlTemplate: template,
      fetch: fetchStub,
      now: () => (t += 40),
    });

    expect(await check("orders")).toEqual({ healthy: true, latencyMs: 40 });
    expect(fetchStub.mock.calls[0]?.[0]).toBe("http://orders.mock.svc.cluster.local:8080/health");
  });

  it("is unhealthy on non-2xx", async () => {
    const fetchStub = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 503 }));
    const check = createHttpHealthChecker({ urlTemplate: template, fetch: fetchStub });
    expect((await check("orders")).healthy).toBe(false);
  });

  it("is unhealthy on network errors and timeouts", async () => {
    const fetchStub = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException("t", "TimeoutError"));
    const check = createHttpHealthChecker({ urlTemplate: template, fetch: fetchStub });
    expect(await check("orders")).toEqual({ healthy: false });
  });

  it("times out after timeoutMs", async () => {
    const hanging: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    const check = createHttpHealthChecker({ urlTemplate: template, fetch: hanging, timeoutMs: 20 });
    expect(await check("orders")).toEqual({ healthy: false });
  });
});
