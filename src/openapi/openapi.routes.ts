import { Router } from "express";
import { buildOpenApiDocument } from "./document.js";

/** `GET /api/openapi.json`, public (BE-040). Built once at startup. */
export function openApiRouter(): Router {
  const document = buildOpenApiDocument();
  return Router().get("/openapi.json", (_req, res) => {
    res.json(document);
  });
}
