import type { Response } from "supertest";
import type { ErrorBody } from "../platform/http/error-handler.js";

/** Typed view of a supertest response body (supertest types `body` as `any`). */
export function bodyOf<T>(res: Response): T {
  return res.body as T;
}

/** The `error` object of an ARCHITECTURE §6 error response. */
export function errorOf(res: Response): ErrorBody["error"] {
  return bodyOf<ErrorBody>(res).error;
}
