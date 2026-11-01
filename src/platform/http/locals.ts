declare global {
  // Express declares `Locals` in a global namespace; augmenting it types `res.locals`.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      /** Set by the request id middleware for every request. */
      requestId: string;
      /** Parsed input from `validate()`; read it with `getInput()`. */
      input?: unknown;
    }
  }
}

export {};
