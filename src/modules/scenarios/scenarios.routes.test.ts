import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { createLogger } from "../../platform/logger.js";
import { bodyOf, errorOf } from "../../test-support/http.js";
import { ordersDownScenario } from "../../test-support/scenarios.js";
import { createStaticScenariosRepo } from "./scenarios.repo.js";
import { scenariosRouter } from "./scenarios.routes.js";

const app = createApp({
  logger: createLogger({ level: "silent" }),
  readinessChecks: [],
  routers: [scenariosRouter({ scenarios: createStaticScenariosRepo([ordersDownScenario()]) })],
});

describe("scenarios routes", () => {
  it("lists summaries", async () => {
    const res = await request(app).get("/api/scenarios");
    expect(res.status).toBe(200);
    expect(bodyOf(res)).toEqual([
      {
        id: "orders-down",
        title: "Orders service is not responding",
        description: "Checkout requests are failing with 5xx.",
        maxResolveSeconds: 600,
      },
    ]);
  });

  it("returns the public view without the answer", async () => {
    const res = await request(app).get("/api/scenarios/orders-down");
    expect(res.status).toBe(200);
    const body = bodyOf<Record<string, unknown>>(res);
    expect(body.targets).toEqual(["gateway", "orders", "worker-svc"]);
    expect(body).not.toHaveProperty("validFixes");
    expect(body).not.toHaveProperty("faults");
    expect(body).not.toHaveProperty("baseline");
  });

  it("returns 404 for an unknown scenario", async () => {
    const res = await request(app).get("/api/scenarios/nope");
    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe("NOT_FOUND");
  });

  it("returns 400 for a malformed id", async () => {
    const res = await request(app).get("/api/scenarios/Not_Kebab");
    expect(res.status).toBe(400);
  });
});
