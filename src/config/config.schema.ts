import { z } from "zod";

export const ProcessKindSchema = z.enum(["api", "worker"]);
export type ProcessKind = z.infer<typeof ProcessKindSchema>;

const port = z.coerce.number().int().min(1).max(65535);
const optionalString = z
  .string()
  .trim()
  .transform((value) => (value === "" ? undefined : value))
  .optional();
const optionalUrl = z
  .string()
  .trim()
  .transform((value) => (value === "" ? undefined : value))
  .pipe(z.url().optional())
  .optional();

/**
 * Every env var from ARCHITECTURE §9. Values that only one mode needs are optional here and
 * enforced in `refineConfig`, so the MVP (D-24) can run without Step Functions, Redis or Cognito.
 */
export const ConfigSchema = z.object({
  NODE_ENV: z.enum(["production", "development", "test"]).default("production"),
  PORT: port.default(3000),
  WORKER_HEALTH_PORT: port.default(3001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  AWS_REGION: z.string().min(1).default("us-east-1"),
  AWS_ENDPOINT_URL: optionalUrl,

  SESSIONS_TABLE: z.string().min(1),
  FILES_BUCKET: z.string().min(1),
  USER_ACTIONS_QUEUE_URL: z.url(),

  ORCHESTRATION_MODE: z.enum(["stepfunctions", "direct"]).default("stepfunctions"),
  STATE_MACHINE_ARN: optionalString,
  FAULTS_QUEUE_URL: optionalUrl,

  ATHENA_WORKGROUP: z.string().min(1).default("oncall-training"),
  ATHENA_DATABASE: z.string().min(1).default("oncall_training"),

  REDIS_URL: optionalUrl,

  AUTH_MODE: z.enum(["cognito", "dev"]).default("cognito"),
  ALLOW_DEV_AUTH: z.stringbool().default(false),
  COGNITO_USER_POOL_ID: optionalString,
  COGNITO_CLIENT_ID: optionalString,

  MOCK_CLUSTER: z.enum(["kubernetes", "fake"]).default("kubernetes"),
  MOCK_NAMESPACE: z.string().min(1).default("mock"),
  MOCK_HEALTH_URL_TEMPLATE: z
    .string()
    .includes("{service}", { message: "must contain the {service} placeholder" })
    .default("http://{service}.mock.svc.cluster.local:8080/health"),

  STATS_MODE: z.enum(["athena", "fixture"]).default("athena"),
});

export type Config = Readonly<z.infer<typeof ConfigSchema>>;

type RawConfig = z.infer<typeof ConfigSchema>;

function requireVar(ctx: z.RefinementCtx, config: RawConfig, key: keyof RawConfig, reason: string) {
  if (config[key] === undefined) {
    ctx.addIssue({ code: "custom", path: [key], message: `required ${reason}` });
  }
}

/** Cross-field rules that depend on the process and the configured modes. */
export function refineConfig(processKind: ProcessKind) {
  return (config: RawConfig, ctx: z.RefinementCtx) => {
    // BE-013 + BE-127: dev auth only in development, unless the MVP escape hatch is set.
    if (config.AUTH_MODE === "dev" && config.NODE_ENV !== "development" && !config.ALLOW_DEV_AUTH) {
      ctx.addIssue({
        code: "custom",
        path: ["AUTH_MODE"],
        message: "AUTH_MODE=dev is only allowed with NODE_ENV=development or ALLOW_DEV_AUTH=true",
      });
    }

    if (processKind !== "api") return;

    if (config.AUTH_MODE === "cognito") {
      requireVar(ctx, config, "COGNITO_USER_POOL_ID", "when AUTH_MODE=cognito");
      requireVar(ctx, config, "COGNITO_CLIENT_ID", "when AUTH_MODE=cognito");
    }
    if (config.ORCHESTRATION_MODE === "stepfunctions") {
      requireVar(ctx, config, "STATE_MACHINE_ARN", "when ORCHESTRATION_MODE=stepfunctions");
    } else {
      requireVar(ctx, config, "FAULTS_QUEUE_URL", "when ORCHESTRATION_MODE=direct");
    }
  };
}
