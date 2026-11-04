import { readFileSync } from "node:fs";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createLogger } from "../platform/logger.js";
import { bodyOf } from "../test-support/http.js";
import { buildOpenApiDocument, renderOpenApiJson } from "./document.js";
import { openApiRouter } from "./openapi.routes.js";

describe("OpenAPI document", () => {
  const document = buildOpenApiDocument();

  it("registers the MVP routes", () => {
    expect(Object.keys(document.paths ?? {}).sort()).toEqual([
      "/api/openapi.json",
      "/api/scenarios",
      "/api/scenarios/{scenarioId}",
      "/api/sessions",
      "/api/sessions/{sessionId}",
      "/api/sessions/{sessionId}/abandon",
      "/api/sessions/{sessionId}/actions",
      "/api/sessions/{sessionId}/dashboard",
      "/api/sessions/{sessionId}/logs",
      "/healthz",
      "/readyz",
    ]);
  });

  it("declares the bearer auth scheme and the shared schemas", () => {
    expect(document.components?.securitySchemes).toHaveProperty("bearerAuth");
    expect(Object.keys(document.components?.schemas ?? {})).toEqual(
      expect.arrayContaining([
        "ErrorBody",
        "ScenarioPublic",
        "SessionView",
        "ActionRequest",
        "DashboardSnapshot",
      ]),
    );
  });

  it("never publishes the scenario answer", () => {
    const text = JSON.stringify(document);
    expect(text).not.toContain("validFixes");
    expect(text).not.toContain("minReplicas");
  });

  it("openapi/openapi.json is up to date (run `pnpm openapi`)", () => {
    const committed = readFileSync(new URL("../../openapi/openapi.json", import.meta.url), "utf8");
    expect(committed).toBe(renderOpenApiJson());
  });
});

describe("GET /api/openapi.json", () => {
  it("serves the document without auth", async () => {
    const app = createApp({
      logger: createLogger({ level: "silent" }),
      readinessChecks: [],
      publicRouters: [openApiRouter()],
      auth: () => {
        throw new Error("auth must not run for the spec");
      },
    });

    const res = await request(app).get("/api/openapi.json");

    expect(res.status).toBe(200);
    expect(bodyOf<{ openapi: string }>(res).openapi).toBe("3.1.0");
  });
});
