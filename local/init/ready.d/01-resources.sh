#!/bin/bash
# Creates what infra's Terraform creates in AWS, with the same names (BE-032..034).
# Runs inside LocalStack on every start; every step is idempotent.
set -euo pipefail

TABLE=Sessions
BUCKET=oncall-training-files-local

if ! awslocal dynamodb describe-table --table-name "$TABLE" >/dev/null 2>&1; then
  awslocal dynamodb create-table \
    --table-name "$TABLE" \
    --billing-mode PAY_PER_REQUEST \
    --attribute-definitions \
      AttributeName=user_id,AttributeType=S \
      AttributeName=session_id,AttributeType=S \
      AttributeName=scenario_id,AttributeType=S \
      AttributeName=score,AttributeType=N \
    --key-schema AttributeName=user_id,KeyType=HASH AttributeName=session_id,KeyType=RANGE \
    --global-secondary-indexes \
      'IndexName=Leaderboard,KeySchema=[{AttributeName=scenario_id,KeyType=HASH},{AttributeName=score,KeyType=RANGE}],Projection={ProjectionType=ALL}' \
    >/dev/null
  echo "created table $TABLE"
fi

awslocal s3 mb "s3://$BUCKET" >/dev/null 2>&1 || true
awslocal s3 sync /scenarios "s3://$BUCKET/scenarios/" --exclude "*" --include "*.json" --delete >/dev/null
echo "synced scenarios to s3://$BUCKET/scenarios/"

# user-actions: FIFO, group = sessionId, dedup = actionId (content-based dedup off), DLQ after 3.
awslocal sqs create-queue --queue-name user-actions-dlq.fifo --attributes FifoQueue=true >/dev/null
ACTIONS_DLQ_ARN=arn:aws:sqs:us-east-1:000000000000:user-actions-dlq.fifo
awslocal sqs create-queue --queue-name user-actions.fifo --attributes "{
  \"FifoQueue\": \"true\",
  \"ContentBasedDeduplication\": \"false\",
  \"VisibilityTimeout\": \"60\",
  \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"$ACTIONS_DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"
}" >/dev/null

# faults: standard queue (infra §7), so the api can delay each message by the warmup.
awslocal sqs create-queue --queue-name faults-dlq >/dev/null
FAULTS_DLQ_ARN=arn:aws:sqs:us-east-1:000000000000:faults-dlq
awslocal sqs create-queue --queue-name faults --attributes "{
  \"VisibilityTimeout\": \"60\",
  \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"$FAULTS_DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"
}" >/dev/null
echo "queues: $(awslocal sqs list-queues --query 'QueueUrls' --output text)"

touch /tmp/oncall-ready
echo "oncall-training local resources ready"
