import type { RequestHandler, Response } from "express";
import type { z } from "zod";
import "./locals.js";

type Schemas = {
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
};

type Infer<T> = T extends z.ZodType ? z.infer<T> : undefined;

export type ValidatedInput<S extends Schemas> = {
  params: Infer<S["params"]>;
  query: Infer<S["query"]>;
  body: Infer<S["body"]>;
};

/**
 * Parses params, query and body with zod and stores them on `res.locals.input`.
 * Never assigns to `req.query` (read-only in Express 5). A `ZodError` becomes 400 in the error handler.
 */
export function validate<S extends Schemas>(schemas: S): RequestHandler {
  return (req, res, next) => {
    res.locals.input = {
      params: schemas.params?.parse(req.params),
      query: schemas.query?.parse(req.query),
      body: schemas.body?.parse(req.body),
    };
    next();
  };
}

/** Typed access to what `validate(schemas)` parsed: `getInput<typeof schemas>(res)`. */
export function getInput<S extends Schemas>(res: Response): ValidatedInput<S> {
  return res.locals.input as ValidatedInput<S>;
}
