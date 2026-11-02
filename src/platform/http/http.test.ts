import express, { type Express } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError, conflict } from "../errors.js";
import { createLogger } from "../logger.js";
import { errorHandler, notFoundHandler } from "./error-handler.js";
import { getInput, validate } from "./validate.js";
import { requestId } from "./request-id.js";
import { bodyOf, errorOf } from "../../test-support/http.js";

const logger = createLogger({ level: "silent" });
const VALID_ULID = "01JBQ4ZJ8V2N7K3M5P6R8S9T0W";

function buildApp(register: (app: Express) => void): Express {
  const app = express();
  app.use(requestId(() => VALID_ULID));
  app.use(express.json());
  register(app);
  app.use(notFoundHandler());
  app.use(errorHandler(logger));
  return app;
}

describe("requestId", () => {
  it("generates an id and echoes it in the response header", async () => {
    const app = buildApp((a) => a.get("/x", (_req, res) => res.json({ id: res.locals.requestId })));

    const res = await request(app).get("/x");

    expect(res.headers["x-request-id"]).toBe(VALID_ULID);
    expect(res.body).toEqual({ id: VALID_ULID });
  });

  it("reuses a valid incoming ULID", async () => {
    const incoming = "01JBQ50000000000000000000A";
    const app = buildApp((a) => a.get("/x", (_req, res) => res.json({ id: res.locals.requestId })));

    const res = await request(app).get("/x").set("x-request-id", incoming);

    expect(res.body).toEqual({ id: incoming });
  });

  it("replaces an incoming id that isn't a ULID", async () => {
    const app = buildApp((a) => a.get("/x", (_req, res) => res.json({ id: res.locals.requestId })));

    const res = await request(app).get("/x").set("x-request-id", "<script>");

    expect(res.body).toEqual({ id: VALID_ULID });
  });
});

describe("errorHandler", () => {
  it("maps an AppError to its status, code and details", async () => {
    const app = buildApp((a) =>
      a.get("/busy", () => {
        throw conflict("SESSION_BUSY", "A scenario is already running.", { retryAfterSeconds: 9 });
      }),
    );

    const res = await request(app).get("/busy");

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: "SESSION_BUSY",
        message: "A scenario is already running.",
        details: { retryAfterSeconds: 9 },
        requestId: VALID_ULID,
      },
    });
  });

  it("maps a ZodError to 400 VALIDATION_ERROR with issue paths", async () => {
    const app = buildApp((a) =>
      a.get("/zod", () => {
        z.object({ scenarioId: z.string() }).parse({});
      }),
    );

    const res = await request(app).get("/zod");

    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe("VALIDATION_ERROR");
    expect((errorOf(res).details as { issues: { path: string }[] }).issues[0]?.path).toBe(
      "scenarioId",
    );
  });

  it("maps unknown errors to 500 INTERNAL without leaking the message or stack", async () => {
    const app = buildApp((a) =>
      a.get("/boom", async () => {
        await Promise.resolve();
        throw new Error("AccessDeniedException: arn:aws:iam::123:role/LabRole");
      }),
    );

    const res = await request(app).get("/boom");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: "INTERNAL", message: "Internal server error.", requestId: VALID_ULID },
    });
    expect(JSON.stringify(res.body)).not.toContain("LabRole");
  });

  it("maps malformed JSON to 400 MALFORMED_JSON", async () => {
    const app = buildApp((a) => a.post("/json", (_req, res) => res.sendStatus(204)));

    const res = await request(app)
      .post("/json")
      .set("content-type", "application/json")
      .send("{not json");

    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe("MALFORMED_JSON");
  });

  it("answers unknown routes with 404 NOT_FOUND in the standard shape", async () => {
    const app = buildApp(() => undefined);

    const res = await request(app).get("/nope");

    expect(res.status).toBe(404);
    expect(errorOf(res)).toMatchObject({ code: "NOT_FOUND", requestId: VALID_ULID });
  });

  it("keeps AppError subclasses' status", () => {
    expect(new AppError("INTERNAL", 418, "teapot").httpStatus).toBe(418);
  });
});

describe("validate", () => {
  const schemas = {
    params: z.object({ sessionId: z.string().length(4) }),
    query: z.object({ limit: z.coerce.number().int().max(50).default(10) }),
    body: z.object({ type: z.enum(["ACKNOWLEDGE"]) }),
  };

  function app() {
    return buildApp((a) =>
      a.post("/s/:sessionId", validate(schemas), (_req, res) => {
        const input = getInput<typeof schemas>(res);
        res.json({ id: input.params.sessionId, limit: input.query.limit, type: input.body.type });
      }),
    );
  }

  it("puts parsed and coerced values on res.locals.input", async () => {
    const res = await request(app()).post("/s/abcd?limit=5").send({ type: "ACKNOWLEDGE" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "abcd", limit: 5, type: "ACKNOWLEDGE" });
  });

  it("applies defaults", async () => {
    const res = await request(app()).post("/s/abcd").send({ type: "ACKNOWLEDGE" });
    expect(bodyOf<{ limit: number }>(res).limit).toBe(10);
  });

  it("rejects invalid input with 400 VALIDATION_ERROR", async () => {
    const res = await request(app()).post("/s/abc?limit=500").send({ type: "NUKE" });

    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe("VALIDATION_ERROR");
  });
});
