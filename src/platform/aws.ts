import { AthenaClient } from "@aws-sdk/client-athena";
import { DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { SFNClient } from "@aws-sdk/client-sfn";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Config } from "../config/index.js";
import type { ReadinessCheck } from "./http/health.js";

export type AwsClients = {
  dynamodb: DynamoDBClient;
  ddbDoc: DynamoDBDocumentClient;
  s3: S3Client;
  sqs: SQSClient;
  sfn: SFNClient;
  athena: AthenaClient;
};

type AwsConfig = Pick<Config, "AWS_REGION" | "AWS_ENDPOINT_URL">;

/**
 * One client per service, created once by each composition root.
 * Never pass `credentials` (AGENTS §7.3): the default chain gives LabRole on EKS (IMDS),
 * `~/.aws` locally, or LocalStack's dummy keys.
 */
export function createAwsClients(config: AwsConfig): AwsClients {
  const base = {
    region: config.AWS_REGION,
    ...(config.AWS_ENDPOINT_URL ? { endpoint: config.AWS_ENDPOINT_URL } : {}),
  };
  const dynamodb = new DynamoDBClient(base);
  return {
    dynamodb,
    ddbDoc: DynamoDBDocumentClient.from(dynamodb, {
      marshallOptions: { removeUndefinedValues: true },
    }),
    // LocalStack serves buckets by path, not by virtual host.
    s3: new S3Client({ ...base, forcePathStyle: Boolean(config.AWS_ENDPOINT_URL) }),
    sqs: new SQSClient(base),
    sfn: new SFNClient(base),
    athena: new AthenaClient(base),
  };
}

export function destroyAwsClients(clients: AwsClients): void {
  clients.ddbDoc.destroy();
  clients.dynamodb.destroy();
  clients.s3.destroy();
  clients.sqs.destroy();
  clients.sfn.destroy();
  clients.athena.destroy();
}

/**
 * `/readyz` checks for the always-on dependencies. Redis joins in M2 together with its client
 * (BE-023, deferred: the Nov 5 MVP has no Redis, D-24).
 */
export function createAwsReadinessChecks(
  clients: Pick<AwsClients, "dynamodb" | "s3">,
  config: Pick<Config, "SESSIONS_TABLE" | "FILES_BUCKET">,
): ReadinessCheck[] {
  return [
    {
      name: "dynamodb",
      check: async (signal) => {
        await clients.dynamodb.send(
          new DescribeTableCommand({ TableName: config.SESSIONS_TABLE }),
          {
            abortSignal: signal,
          },
        );
      },
    },
    {
      name: "s3",
      check: async (signal) => {
        await clients.s3.send(new HeadBucketCommand({ Bucket: config.FILES_BUCKET }), {
          abortSignal: signal,
        });
      },
    },
  ];
}
