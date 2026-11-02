import type { z } from "zod";
import { type Config, ConfigSchema, type ProcessKind, refineConfig } from "./config.schema.js";

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

function formatIssue(issue: z.core.$ZodIssue): string {
  const key = issue.path.join(".") || "(root)";
  return `${key}: ${issue.message}`;
}

/**
 * Parses the environment once at startup. Throws a `ConfigError` listing every failing variable.
 * Code reads `config.X`, never `process.env.X` (CONVENTIONS §6).
 */
export function loadConfig(
  env: Record<string, string | undefined>,
  processKind: ProcessKind,
): Config {
  const result = ConfigSchema.superRefine(refineConfig(processKind)).safeParse(env);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map(formatIssue));
  }
  return Object.freeze(result.data);
}

/** True when dev auth runs outside development (the Nov 5 MVP, BE-127). Logged as a warning. */
export function isDevAuthOutsideDevelopment(config: Config): boolean {
  return config.AUTH_MODE === "dev" && config.NODE_ENV !== "development";
}
