import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../platform/http/error-handler.js";
import { requestId } from "../../platform/http/request-id.js";
import { createLogger } from "../../platform/logger.js";
import { bodyOf, errorOf } from "../../test-support/http.js";
import {
  type AccessTokenVerifier,
  createAuthMiddleware,
  currentUser,
  parseDevUser,
} from "./auth.middleware.js";

const logger = createLogger({ level: "silent" });

function appWith(auth: express.RequestHandler) {
  const app = express();
  app.use(requestId());
  app.use(auth);
  app.get("/me", (req, res) => res.json(currentUser(req)));
  app.use(errorHandler(logger));
  return app;
}

describe("parseDevUser", () => {
  it.each([
    ["alice", { userId: "alice", username: "alice" }],
    ["u-1:Alice", { userId: "u-1", username: "Alice" }],
    ["a@b.c:a.b", { userId: "a@b.c", username: "a.b" }],
  ])("parses %s", (header, user) => {
    expect(parseDevUser(header)).toEqual(user);
  });

  it.each([undefined, "", "a:b:c", "has space", "<script>", "x".repeat(129)])(
    "rejects %s",
    (header) => {
      expect(parseDevUser(header)).toBeUndefined();
    },
  );
});

describe("dev auth", () => {
  const app = appWith(createAuthMiddleware({ mode: "dev", logger }));

  it("sets req.user from x-dev-user", async () => {
    const res = await request(app).get("/me").set("x-dev-user", "u-1:alice");
    expect(res.status).toBe(200);
    expect(bodyOf(res)).toEqual({ userId: "u-1", username: "alice" });
  });

  it("answers 401 without the header", async () => {
    const res = await request(app).get("/me");
    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe("UNAUTHORIZED");
  });

  it("ignores a bearer token", async () => {
    const res = await request(app).get("/me").set("authorization", "Bearer abc");
    expect(res.status).toBe(401);
  });
});

describe("cognito auth", () => {
  it("sets req.user from the verified claims", async () => {
    const verifier = vi
      .fn<AccessTokenVerifier>()
      .mockResolvedValue({ sub: "sub-1", username: "alice" });
    const app = appWith(createAuthMiddleware({ mode: "cognito", logger, verifier }));

    const res = await request(app).get("/me").set("authorization", "Bearer good.jwt");

    expect(res.status).toBe(200);
    expect(bodyOf(res)).toEqual({ userId: "sub-1", username: "alice" });
    expect(verifier).toHaveBeenCalledWith("good.jwt");
  });

  it("falls back to sub when the token has no username", async () => {
    const verifier: AccessTokenVerifier = () => Promise.resolve({ sub: "sub-1" });
    const app = appWith(createAuthMiddleware({ mode: "cognito", logger, verifier }));

    const res = await request(app).get("/me").set("authorization", "Bearer t");

    expect(bodyOf(res)).toEqual({ userId: "sub-1", username: "sub-1" });
  });

  it("answers 401 for an invalid token without leaking the reason", async () => {
    const verifier: AccessTokenVerifier = () => Promise.reject(new Error("JwtExpiredError: exp"));
    const app = appWith(createAuthMiddleware({ mode: "cognito", logger, verifier }));

    const res = await request(app).get("/me").set("authorization", "Bearer old.jwt");

    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain("Expired");
  });

  it.each([undefined, "Basic abc", "Bearer", "bearer"])(
    "answers 401 for authorization header %s",
    async (header) => {
      const verifier = vi.fn<AccessTokenVerifier>();
      const app = appWith(createAuthMiddleware({ mode: "cognito", logger, verifier }));
      const req = request(app).get("/me");
      const res = await (header ? req.set("authorization", header) : req);
      expect(res.status).toBe(401);
      expect(verifier).not.toHaveBeenCalled();
    },
  );

  it("ignores x-dev-user in cognito mode", async () => {
    const verifier = vi.fn<AccessTokenVerifier>();
    const app = appWith(createAuthMiddleware({ mode: "cognito", logger, verifier }));

    const res = await request(app).get("/me").set("x-dev-user", "admin");

    expect(res.status).toBe(401);
  });

  it("refuses to build without a verifier", () => {
    expect(() => createAuthMiddleware({ mode: "cognito", logger })).toThrow("verifier");
  });
});
