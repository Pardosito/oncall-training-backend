import {
  CreateTableCommand,
  DeleteTableCommand,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { CreateQueueCommand, DeleteQueueCommand } from "@aws-sdk/client-sqs";
import { ulid } from "ulid";
import { type AwsClients, createAwsClients, destroyAwsClients } from "../../src/platform/aws.js";

/** Same endpoint and bucket as `.env.example` / `local/init` (BE-037). */
export const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
export const BUCKET = process.env.FILES_BUCKET ?? "oncall-training-files-local";

// LocalStack accepts any keys; set dummies only if the developer has none in the environment.
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";

export async function localstackAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${ENDPOINT}/_localstack/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** `describe.skipIf(!available)` with one clear message instead of a wall of connection errors. */
export const available = await localstackAvailable();
if (!available) {
  process.stderr.write(
    `\nLocalStack is not reachable at ${ENDPOINT}: run \`docker compose up -d\`. Skipping.\n`,
  );
}

export function localClients(): AwsClients {
  return createAwsClients({ AWS_REGION: "us-east-1", AWS_ENDPOINT_URL: ENDPOINT });
}

/** A throwaway copy of the `Sessions` table, so tests never touch (or block) dev data. */
export async function createTempSessionsTable(aws: AwsClients): Promise<string> {
  const TableName = `Sessions-it-${ulid()}`;
  await aws.dynamodb.send(
    new CreateTableCommand({
      TableName,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "user_id", AttributeType: "S" },
        { AttributeName: "session_id", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "user_id", KeyType: "HASH" },
        { AttributeName: "session_id", KeyType: "RANGE" },
      ],
    }),
  );
  await waitUntilTableExists({ client: aws.dynamodb, maxWaitTime: 30 }, { TableName });
  return TableName;
}

export async function deleteTable(aws: AwsClients, TableName: string): Promise<void> {
  await aws.dynamodb.send(new DeleteTableCommand({ TableName })).catch(() => undefined);
}

/** Throwaway queues shaped like `faults` (standard) and `user-actions.fifo`. */
export async function createTempQueues(aws: AwsClients) {
  const id = ulid().toLowerCase();
  const faults = await aws.sqs.send(new CreateQueueCommand({ QueueName: `faults-it-${id}` }));
  const actions = await aws.sqs.send(
    new CreateQueueCommand({
      QueueName: `user-actions-it-${id}.fifo`,
      Attributes: {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
        VisibilityTimeout: "60",
      },
    }),
  );
  return { faultsUrl: faults.QueueUrl ?? "", actionsUrl: actions.QueueUrl ?? "" };
}

export async function deleteQueues(aws: AwsClients, urls: string[]): Promise<void> {
  await Promise.all(
    urls.map((QueueUrl) =>
      aws.sqs.send(new DeleteQueueCommand({ QueueUrl })).catch(() => undefined),
    ),
  );
}

export { destroyAwsClients };
