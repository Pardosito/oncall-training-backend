import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { ErrorCodeSchema } from "../platform/errors.js";

/** Identifiers from the API: ULIDs for sessions and actions. */
export const UlidSchema = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "must be a ULID")
  .meta({ example: "01JBQ4ZJ8V2N7K3M5P6R8S9T0W" });

export const IsoDateTimeSchema = z.iso.datetime().meta({ example: "2026-11-05T18:04:12.000Z" });

/** ARCHITECTURE §6 error body. */
export const ErrorBodySchema = z
  .object({
    error: z.object({
      code: ErrorCodeSchema,
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
      requestId: z.string(),
    }),
  })
  .meta({ id: "ErrorBody" });

export const BEARER_AUTH = "bearerAuth";

export function createRegistry(): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();
  registry.registerComponent("securitySchemes", BEARER_AUTH, {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description: "Cognito access token. With AUTH_MODE=dev, send `x-dev-user` instead.",
  });
  return registry;
}

/** Standard error responses for a route, keyed by status code. */
export function errorResponses(...statuses: number[]) {
  const descriptions: Record<number, string> = {
    400: "Malformed request (`VALIDATION_ERROR`, `MALFORMED_JSON`)",
    401: "Missing or invalid credentials (`UNAUTHORIZED`)",
    404: "Not found, or not yours (`NOT_FOUND`)",
    409: "State conflict",
    422: "Valid shape but not allowed",
    503: "A dependency is unavailable",
    504: "An upstream call timed out",
  };
  return Object.fromEntries(
    [...statuses, 500].map((status) => [
      status,
      {
        description: descriptions[status] ?? "Internal error (`INTERNAL`)",
        content: { "application/json": { schema: ErrorBodySchema } },
      },
    ]),
  );
}

export function jsonContent(schema: z.ZodType) {
  return { content: { "application/json": { schema } } };
}
