import type { ErrorRequestHandler, RequestHandler, Response } from "express";
import { ZodError } from "zod";
import { AppError, type ErrorCode, type ErrorDetails, notFound } from "../errors.js";
import type { Logger } from "../logger.js";
import "./locals.js";

/** ARCHITECTURE §6 error body. */
export type ErrorBody = {
  error: { code: ErrorCode; message: string; details?: ErrorDetails; requestId: string };
};

export function sendError(res: Response, error: AppError): void {
  const body: ErrorBody = {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
      requestId: res.locals.requestId,
    },
  };
  res.status(error.httpStatus).json(body);
}

/** body-parser errors carry `type` and `status`; map the ones a client can cause. */
function fromBodyParser(error: unknown): AppError | undefined {
  if (typeof error !== "object" || error === null || !("type" in error)) return undefined;
  switch (error.type) {
    case "entity.too.large":
      return new AppError("PAYLOAD_TOO_LARGE", 413, "Request body is too large.");
    case "entity.parse.failed":
      return new AppError("MALFORMED_JSON", 400, "Request body is not valid JSON.");
    case "encoding.unsupported":
    case "charset.unsupported":
      return new AppError("UNSUPPORTED_MEDIA_TYPE", 415, "Unsupported request encoding.");
    default:
      return undefined;
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) {
    return new AppError("VALIDATION_ERROR", 400, "Request validation failed.", {
      issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  return fromBodyParser(error) ?? new AppError("INTERNAL", 500, "Internal server error.");
}

export function notFoundHandler(): RequestHandler {
  return (_req, res) => {
    sendError(res, notFound("Route not found."));
  };
}

/** Never leaks stack traces or upstream messages; logs the full error instead. */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const appError = toAppError(error);
    const context = { err: error, requestId: res.locals.requestId };
    if (appError.httpStatus >= 500) {
      logger.error(context, "request failed");
    } else {
      logger.debug(context, "request rejected");
    }
    sendError(res, appError);
  };
}
