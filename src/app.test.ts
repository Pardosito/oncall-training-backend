import { Router } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { unauthorized } from "./platform/errors.js";
import type { ReadinessCheck } from "./platform/http/health.js";
import { createLogger } from "./platform/logger.js";
import { errorOf } from "./test-support/http.js";

const logger = createLogger({ level: "silent" });

const okCheck = (name: string): ReadinessCheck => ({ name, check: () => Promise.resolve() });
const failingCheck = (name: string): ReadinessCheck => ({
  name,
  check: () => Promise.reject(new Error("ResourceNotFoundException: table Sessions")),
});
const hangingCheck = (name: string): ReadinessCheck => ({
  name,
  check: (signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason as Error));
    }),
});

describe("createApp", () => {
  it("GET /healthz answers 200 without checking dependencies", async () => {
    const app = createApp({ logger, readinessChecks: [failingCheck("dynamodb")] });

    const res = await request(app).get("/healthz");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /readyz answers 200 when every check passes", async () => {
    const app = createApp({ logger, readinessChecks: [okCheck("dynamodb"), okCheck("s3")] });

    const res = await request(app).get("/readyz");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready", checks: { dynamodb: "ok", s3: "ok" } });
  });

  it("GET /readyz answers 503 naming the failed check, without the AWS error text", async () => {
    const app = createApp({ logger, readinessChecks: [failingCheck("dynamodb"), okCheck("s3")] });

    const res = await request(app).get("/readyz");

    expect(res.status).toBe(503);
    expect(errorOf(res)).toMatchObject({
      code: "NOT_READY",
      details: { checks: { dynamodb: "fail", s3: "ok" } },
    });
    expect(JSON.stringify(res.body)).not.toContain("ResourceNotFound");
  });

  it("GET /readyz fails a check that doesn't answer in time", async () => {
    const { runReadinessChecks } = await import("./platform/http/health.js");

    const result = await runReadinessChecks([hangingCheck("s3")], logger, 20);

    expect(result).toEqual({ ready: false, checks: { s3: "fail" } });
  });

  it("rejects an oversize body with 413 in the standard error shape", async () => {
    const router = Router().post("/echo", (_req, res) => res.sendStatus(204));
    const app = createApp({ logger, readinessChecks: [], routers: [router] });

    const res = await request(app)
      .post("/api/echo")
      .send({ blob: "x".repeat(101 * 1024) });

    expect(res.status).toBe(413);
    expect(errorOf(res).code).toBe("PAYLOAD_TOO_LARGE");
    expect(errorOf(res).requestId).toEqual(expect.any(String));
  });

  it("does not send x-powered-by or CORS headers", async () => {
    const app = createApp({ logger, readinessChecks: [] });

    const res = await request(app).get("/healthz").set("origin", "https://evil.example");

    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("mounts public routers before auth and feature routers after it", async () => {
    const publicRouter = Router().get("/openapi.json", (_req, res) => res.json({ openapi: "3" }));
    const privateRouter = Router().get("/scenarios", (_req, res) => res.json([]));
    const app = createApp({
      logger,
      readinessChecks: [],
      publicRouters: [publicRouter],
      auth: () => {
        throw unauthorized();
      },
      routers: [privateRouter],
    });

    expect((await request(app).get("/api/openapi.json")).status).toBe(200);
    expect((await request(app).get("/api/scenarios")).status).toBe(401);
    expect((await request(app).get("/healthz")).status).toBe(200);
  });
});
