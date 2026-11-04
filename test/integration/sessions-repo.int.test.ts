import { afterAll, beforeAll, describe } from "vitest";
import { createDynamoSessionsRepo } from "../../src/modules/sessions/index.js";
import { describeSessionsRepoContract } from "../../src/test-support/sessions-repo.contract.js";
import {
  available,
  createTempSessionsTable,
  deleteTable,
  destroyAwsClients,
  localClients,
} from "../helpers/localstack.js";

describe.skipIf(!available)("DynamoDB sessions repo (LocalStack)", () => {
  const aws = localClients();
  let table = "";

  beforeAll(async () => {
    table = await createTempSessionsTable(aws);
  });
  afterAll(async () => {
    await deleteTable(aws, table);
    destroyAwsClients(aws);
  });

  describeSessionsRepoContract("dynamodb", () =>
    createDynamoSessionsRepo({ ddb: aws.ddbDoc, table }),
  );
});
