import { z } from "zod";

/**
 * Every error code the API can return (ARCHITECTURE §6). Published as an enum in openapi.json,
 * so the frontend can switch on it; add a code here before throwing it.
 */
export const ErrorCodeSchema = z
  .enum([
    "VALIDATION_ERROR",
    "MALFORMED_JSON",
    "UNAUTHORIZED",
    "NOT_FOUND",
    "SESSION_BUSY",
    "SESSION_NOT_ACTIVE",
    "PAYLOAD_TOO_LARGE",
    "UNSUPPORTED_MEDIA_TYPE",
    "ACTION_NOT_ALLOWED",
    "INTERNAL",
    "UNAVAILABLE",
    "NOT_READY",
    "STATS_TIMEOUT",
  ])
  .meta({ id: "ErrorCode" });
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export type ErrorDetails = Record<string, unknown>;

/** The only error type routes and services throw on purpose (CONVENTIONS §5). */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly httpStatus: number,
    message: string,
    readonly details?: ErrorDetails,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function badRequest(code: ErrorCode, message: string, details?: ErrorDetails): AppError {
  return new AppError(code, 400, message, details);
}

export function unauthorized(message = "Missing or invalid credentials."): AppError {
  return new AppError("UNAUTHORIZED", 401, message);
}

export function notFound(message = "Resource not found."): AppError {
  return new AppError("NOT_FOUND", 404, message);
}

export function conflict(code: ErrorCode, message: string, details?: ErrorDetails): AppError {
  return new AppError(code, 409, message, details);
}

export function unprocessable(code: ErrorCode, message: string, details?: ErrorDetails): AppError {
  return new AppError(code, 422, message, details);
}

export function unavailable(message = "A dependency is unavailable.", details?: ErrorDetails) {
  return new AppError("UNAVAILABLE", 503, message, details);
}

export function gatewayTimeout(code: ErrorCode, message = "An upstream call timed out."): AppError {
  return new AppError(code, 504, message);
}
