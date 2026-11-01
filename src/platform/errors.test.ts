import { describe, expect, it } from "vitest";
import {
  AppError,
  badRequest,
  conflict,
  gatewayTimeout,
  notFound,
  unauthorized,
  unavailable,
  unprocessable,
} from "./errors.js";

describe("error helpers", () => {
  it.each([
    [badRequest("MALFORMED_JSON", "bad"), 400, "MALFORMED_JSON"],
    [unauthorized(), 401, "UNAUTHORIZED"],
    [notFound(), 404, "NOT_FOUND"],
    [conflict("SESSION_BUSY", "busy"), 409, "SESSION_BUSY"],
    [unprocessable("ACTION_NOT_ALLOWED", "no"), 422, "ACTION_NOT_ALLOWED"],
    [unavailable(), 503, "UNAVAILABLE"],
    [gatewayTimeout("STATS_TIMEOUT"), 504, "STATS_TIMEOUT"],
  ])("builds an AppError with status %#", (error, status, code) => {
    expect(error).toBeInstanceOf(AppError);
    expect(error.httpStatus).toBe(status);
    expect(error.code).toBe(code);
  });

  it("keeps details", () => {
    const error = conflict("SESSION_BUSY", "busy", { retryAfterSeconds: 12 });
    expect(error.details).toEqual({ retryAfterSeconds: 12 });
  });
});
