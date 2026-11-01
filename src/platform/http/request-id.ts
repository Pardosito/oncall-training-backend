import type { RequestHandler } from "express";
import { ulid } from "ulid";
import "./locals.js";

export const REQUEST_ID_HEADER = "x-request-id";
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Reuses a valid incoming ULID (e.g. from the SPA) or generates one, and echoes it back. */
export function requestId(generate: () => string = ulid): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get(REQUEST_ID_HEADER);
    const id = incoming && ULID_PATTERN.test(incoming) ? incoming : generate();
    res.locals.requestId = id;
    res.setHeader(REQUEST_ID_HEADER, id);
    next();
  };
}
