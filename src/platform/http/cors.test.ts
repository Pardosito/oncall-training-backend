import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { corsAllowlist } from "./cors.js";

const SITE = "http://site.example:4566";

function app() {
  const a = express();
  a.use(corsAllowlist([SITE]));
  a.get("/api/x", (_req, res) => res.json({ ok: true }));
  return a;
}

describe("corsAllowlist", () => {
  it("allows a listed origin and exposes x-request-id", async () => {
    const res = await request(app()).get("/api/x").set("origin", SITE);
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(SITE);
    expect(res.headers["access-control-expose-headers"]).toBe("x-request-id");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(res.headers.vary).toContain("Origin");
  });

  it("answers the preflight for a listed origin", async () => {
    const res = await request(app())
      .options("/api/x")
      .set("origin", SITE)
      .set("access-control-request-method", "POST")
      .set("access-control-request-headers", "authorization, content-type");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-headers"]).toContain("authorization");
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
  });

  it("adds nothing for other origins or same-origin requests", async () => {
    const other = await request(app()).get("/api/x").set("origin", "https://evil.example");
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
    const same = await request(app()).get("/api/x");
    expect(same.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
