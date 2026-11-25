import type { RequestHandler } from "express";

const ALLOWED_HEADERS = "authorization, content-type, x-request-id";
const ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";

/**
 * CORS for an explicit allowlist of origins (D-35: the SPA on the S3 website endpoint, the API on
 * the ALB). Requests from other origins get no CORS headers, so the browser blocks them. No
 * credentials (cookies) are allowed: the API authenticates with a bearer token.
 */
export function corsAllowlist(origins: readonly string[]): RequestHandler {
  const allowed = new Set(origins);
  return (req, res, next) => {
    const origin = req.get("origin");
    if (!origin || !allowed.has(origin)) return next();

    res.vary("Origin");
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-expose-headers", "x-request-id");
    if (req.method === "OPTIONS" && req.get("access-control-request-method")) {
      res.setHeader("access-control-allow-methods", ALLOWED_METHODS);
      res.setHeader("access-control-allow-headers", ALLOWED_HEADERS);
      res.setHeader("access-control-max-age", "600");
      res.status(204).end();
      return;
    }
    next();
  };
}
