import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createS3ScenariosRepo } from "../../src/modules/scenarios/index.js";
import { createLogger } from "../../src/platform/logger.js";
import { createSqsQueue } from "../../src/platform/queue.js";
import {
  available,
  BUCKET,
  createTempQueues,
  deleteQueues,
  destroyAwsClients,
  localClients,
} from "../helpers/localstack.js";

describe.skipIf(!available)("S3 scenarios and SQS queue (LocalStack)", () => {
  const aws = localClients();
  const queue = createSqsQueue(aws.sqs, 1);
  let urls = { faultsUrl: "", actionsUrl: "" };

  beforeAll(async () => {
    urls = await createTempQueues(aws);
  });
  afterAll(async () => {
    await deleteQueues(aws, [urls.faultsUrl, urls.actionsUrl]);
    destroyAwsClients(aws);
  });

  it("loads the scenarios uploaded by local/init", async () => {
    const repo = createS3ScenariosRepo({
      s3: aws.s3,
      bucket: BUCKET,
      logger: createLogger({ level: "silent" }),
    });
    const scenario = await repo.get("orders-down");
    expect(scenario?.validFixes).toEqual([
      { type: "SCALE_DEPLOYMENT", target: "orders", minReplicas: 1 },
    ]);
  });

  it("round-trips FIFO messages and drops a duplicate actionId", async () => {
    await queue.send(urls.actionsUrl, { n: 1 }, { groupId: "s1", dedupId: "a1" });
    await queue.send(urls.actionsUrl, { n: 1 }, { groupId: "s1", dedupId: "a1" });
    await queue.send(urls.actionsUrl, { n: 2 }, { groupId: "s1", dedupId: "a2" });

    const received = await queue.receive(urls.actionsUrl);
    expect(received.map((m) => JSON.parse(m.body) as unknown)).toEqual([{ n: 1 }, { n: 2 }]);
    for (const m of received) await queue.delete(urls.actionsUrl, m.receiptHandle);
    expect(await queue.receive(urls.actionsUrl)).toEqual([]);
  });

  it("delays a message on the standard faults queue", async () => {
    await queue.send(urls.faultsUrl, { fault: true }, { delaySeconds: 2 });
    expect(await queue.receive(urls.faultsUrl)).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const [message] = await queue.receive(urls.faultsUrl);
    expect(JSON.parse(message?.body ?? "{}")).toEqual({ fault: true });
  });
});
