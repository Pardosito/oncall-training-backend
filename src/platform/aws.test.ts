import { describe, expect, it } from "vitest";
import { createAwsClients, createAwsReadinessChecks, destroyAwsClients } from "./aws.js";

describe("createAwsClients", () => {
  it("uses the configured region and no custom endpoint by default", async () => {
    const clients = createAwsClients({ AWS_REGION: "us-east-1", AWS_ENDPOINT_URL: undefined });

    expect(await clients.sqs.config.region()).toBe("us-east-1");
    expect(clients.sqs.config.endpoint).toBeUndefined();
    expect(clients.s3.config.forcePathStyle).toBe(false);
    destroyAwsClients(clients);
  });

  it("points every client at LocalStack when AWS_ENDPOINT_URL is set", async () => {
    const clients = createAwsClients({
      AWS_REGION: "us-east-1",
      AWS_ENDPOINT_URL: "http://localhost:4566",
    });

    const endpoint = await clients.dynamodb.config.endpoint?.();
    expect(endpoint?.hostname).toBe("localhost");
    expect(clients.s3.config.forcePathStyle).toBe(true);
    destroyAwsClients(clients);
  });
});

describe("createAwsReadinessChecks", () => {
  it("checks DynamoDB and S3 only (Redis is deferred to M2)", () => {
    const clients = createAwsClients({ AWS_REGION: "us-east-1", AWS_ENDPOINT_URL: undefined });

    const checks = createAwsReadinessChecks(clients, {
      SESSIONS_TABLE: "Sessions",
      FILES_BUCKET: "files",
    });

    expect(checks.map((check) => check.name)).toEqual(["dynamodb", "s3"]);
    destroyAwsClients(clients);
  });
});
