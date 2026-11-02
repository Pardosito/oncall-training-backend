import { describe, expect, it } from "vitest";
import { ConfigError, isDevAuthOutsideDevelopment, loadConfig } from "./index.js";

const baseEnv = {
  SESSIONS_TABLE: "Sessions",
  FILES_BUCKET: "oncall-training-files-123",
  USER_ACTIONS_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123/user-actions.fifo",
};

const apiEnv = {
  ...baseEnv,
  COGNITO_USER_POOL_ID: "us-east-1_abc",
  COGNITO_CLIENT_ID: "client",
  STATE_MACHINE_ARN: "arn:aws:states:us-east-1:123:stateMachine:scenario",
};

/** What infra's render-config writes for the Nov 5 MVP (infra INF-139). */
const mvpApiEnv = {
  ...baseEnv,
  AUTH_MODE: "dev",
  ALLOW_DEV_AUTH: "true",
  ORCHESTRATION_MODE: "direct",
  FAULTS_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123/faults",
  STATS_MODE: "athena",
};

function errorOf(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("expected loadConfig to throw");
}

describe("loadConfig", () => {
  it("parses a valid api env with defaults and coercion", () => {
    const config = loadConfig({ ...apiEnv, PORT: "8080" }, "api");

    expect(config.PORT).toBe(8080);
    expect(config.WORKER_HEALTH_PORT).toBe(3001);
    expect(config.NODE_ENV).toBe("production");
    expect(config.AUTH_MODE).toBe("cognito");
    expect(config.ORCHESTRATION_MODE).toBe("stepfunctions");
    expect(config.MOCK_CLUSTER).toBe("kubernetes");
    expect(config.REDIS_URL).toBeUndefined();
    expect(config.ATHENA_WORKGROUP).toBe("oncall-training");
  });

  it("returns a frozen object", () => {
    const config = loadConfig(apiEnv, "api");
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("lists every missing required variable", () => {
    const error = errorOf(() => loadConfig({}, "worker"));

    expect(error.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("SESSIONS_TABLE"),
        expect.stringContaining("FILES_BUCKET"),
        expect.stringContaining("USER_ACTIONS_QUEUE_URL"),
      ]),
    );
  });

  it("rejects a bad enum value", () => {
    const error = errorOf(() => loadConfig({ ...apiEnv, MOCK_CLUSTER: "kind" }, "api"));
    expect(error.issues).toEqual([expect.stringContaining("MOCK_CLUSTER")]);
  });

  it("treats empty strings as unset for optional vars", () => {
    const config = loadConfig({ ...apiEnv, REDIS_URL: "", AWS_ENDPOINT_URL: "" }, "api");
    expect(config.REDIS_URL).toBeUndefined();
    expect(config.AWS_ENDPOINT_URL).toBeUndefined();
  });

  it("requires the health URL template to contain {service}", () => {
    const error = errorOf(() =>
      loadConfig({ ...apiEnv, MOCK_HEALTH_URL_TEMPLATE: "http://orders/health" }, "api"),
    );
    expect(error.issues).toEqual([expect.stringContaining("MOCK_HEALTH_URL_TEMPLATE")]);
  });

  describe("per-process and per-mode requirements", () => {
    it("requires Cognito and the state machine for the api by default", () => {
      const error = errorOf(() => loadConfig(baseEnv, "api"));

      expect(error.issues).toEqual(
        expect.arrayContaining([
          expect.stringContaining("COGNITO_USER_POOL_ID"),
          expect.stringContaining("COGNITO_CLIENT_ID"),
          expect.stringContaining("STATE_MACHINE_ARN"),
        ]),
      );
    });

    it("does not require api-only vars for the worker", () => {
      expect(() => loadConfig(baseEnv, "worker")).not.toThrow();
    });

    it("requires FAULTS_QUEUE_URL in direct orchestration mode", () => {
      const error = errorOf(() => loadConfig({ ...mvpApiEnv, FAULTS_QUEUE_URL: undefined }, "api"));
      expect(error.issues).toEqual([expect.stringContaining("FAULTS_QUEUE_URL")]);
    });

    it("accepts the Nov 5 MVP env without Redis, Cognito, Step Functions or Athena vars", () => {
      const config = loadConfig(mvpApiEnv, "api");

      expect(config.ORCHESTRATION_MODE).toBe("direct");
      expect(config.STATE_MACHINE_ARN).toBeUndefined();
      expect(config.COGNITO_USER_POOL_ID).toBeUndefined();
    });
  });

  describe("dev auth (BE-013, BE-127)", () => {
    it("refuses AUTH_MODE=dev outside development", () => {
      const error = errorOf(() => loadConfig({ ...baseEnv, AUTH_MODE: "dev" }, "worker"));
      expect(error.issues).toEqual([expect.stringContaining("AUTH_MODE")]);
    });

    it("accepts AUTH_MODE=dev in development", () => {
      const config = loadConfig(
        { ...baseEnv, AUTH_MODE: "dev", NODE_ENV: "development" },
        "worker",
      );
      expect(isDevAuthOutsideDevelopment(config)).toBe(false);
    });

    it("accepts AUTH_MODE=dev outside development when ALLOW_DEV_AUTH=true", () => {
      const config = loadConfig({ ...mvpApiEnv, NODE_ENV: "production" }, "api");
      expect(isDevAuthOutsideDevelopment(config)).toBe(true);
    });

    it("still refuses when ALLOW_DEV_AUTH=false", () => {
      const error = errorOf(() => loadConfig({ ...mvpApiEnv, ALLOW_DEV_AUTH: "false" }, "api"));
      expect(error.issues).toEqual([expect.stringContaining("AUTH_MODE")]);
    });
  });
});
