# Backend Architecture

Living document, and the source of truth for every contract this repo owns or depends on.
Items marked **(planned)** aren't built yet. Items marked **(cross-repo)** must be honored by another repo; change them only together with that repo's owner.

## 1. Where the backend sits

```
Browser (SPA)
   │ https://<cloudfront>/api/*            (same origin → no CORS)
   ▼
CloudFront ──► ALB ──► EKS ns:app
                        ├── api      (Deployment, 2 replicas)   HTTP :3000
                        └── worker   (Deployment, 1 replica)    health :3001
                               │
   ┌───────────────────────────┼───────────────────────────────────────────────┐
   │ AWS SDK v3 (LabRole via node)          Kubernetes API (ServiceAccount + RBAC)
   ▼                                        ▼
DynamoDB Sessions · S3 files bucket        EKS ns:mock  (gateway → orders → worker-svc)
SQS user-actions (FIFO) · Step Functions   read pods/deployments/logs, scale, restart
Athena/Glue · ElastiCache Redis
                        ▲
Step Functions ──► SQS faults ──► injector (infra repo) ──► ns:mock
```

## 2. Processes

The same image runs with different start commands.

| Process | Command | Replicas | Does |
|---|---|---|---|
| **api** | `node dist/api.js` | 2 | Stateless HTTP. Validates the JWT and the request, reads and writes DynamoDB, Redis and S3, starts Step Functions executions, enqueues user actions, runs Athena queries, reads pod logs (read-only k8s). |
| **worker** | `node dist/worker.js` | **1** | (a) **Actions consumer**: long-polls SQS `user-actions` and applies actions to the mock system. (b) **Monitor loop** (every 2 s while a session is active): reads mock-system state, writes the dashboard snapshot to Redis, detects resolution and calls `SendTaskSuccess`. (c) **Session end**: on `SESSION_ENDED`, flushes logs to S3, resets the mock system and releases the lock. |

The worker runs as a single replica on purpose: only one session exists at a time, and a second monitor would double-resolve. See DECISIONS D-08.

## 3. Modules (`src/modules/*`)

| Module | Responsibility | Talks to |
|---|---|---|
| `auth` | JWT middleware: verifies the Cognito access token and sets `req.user = { userId, username }`. Dev mode accepts the `x-dev-user` header. | Cognito JWKS |
| `scenarios` | Loads and validates scenario JSON and caches it in memory. | S3 `scenarios/` (local: LocalStack) |
| `sessions` | Session lifecycle: create (with the global lock), get, list user history, abandon. Owns the session item schema and state transitions. | DynamoDB, Redis, `orchestration`, `events` |
| `actions` | API side: validates actions against the scenario and enqueues them. Worker side: applies them and checks whether they are valid fixes. | SQS, `mock-cluster`, `events` |
| `dashboard` | API side: serves the snapshot. Worker side: builds the snapshot and runs resolution detection. | Redis, `mock-cluster` |
| `mock-cluster` | **Gateway** to the mock system: list pods and deployments, read logs, scale, rollout restart, HTTP health checks. Has a `fake` in-memory implementation. | Kubernetes API, mock services `/health` |
| `orchestration` | Wrapper over Step Functions: `start`, `completeTask`, `failTask`. | Step Functions |
| `events` | Session event log: append to a Redis list; flush to S3 as NDJSON at session end. | Redis, S3 |
| `scoring` | Pure functions: TTD, TTR, score. No I/O. | none |
| `stats` | Runs named Athena queries for the current user; caches results. | Athena, Redis |
| `leaderboard` | Top scores per scenario; cached. | DynamoDB GSI, Redis |

Shared infrastructure lives in `src/platform/`: `aws.ts` (client singletons), `redis.ts`, `k8s.ts`, `logger.ts`, `errors.ts`, `lock.ts`, `http/` (validate, error handler, request id).

## 3.1 Users and identity

- **Cognito is the user store.** We don't keep a users table. Sign-up, sign-in, password reset and email verification are Cognito managed login; the backend has no user routes besides `/api/me/*`.
- On every request the `auth` middleware verifies the access token and sets `req.user = { userId: sub, username }`. Both values come only from the verified token, never from the body, query or a header (except `x-dev-user` in `AUTH_MODE=dev`).
- **Separation rules:**

| Data | Keyed by | Who can read it |
|---|---|---|
| Session item, score, TTD/TTR | DynamoDB PK `user_id` | Only that user (reads always use `PK = req.user.userId`) |
| History (`/api/me/sessions`) | `Query` on `user_id` | Only that user |
| Stats (`/api/me/stats/*`) | Athena `WHERE user_id = ?` + Redis `stats:{userId}:…` | Only that user |
| Dashboard, actions, logs of a session | Session ownership checked first | Only the session owner |
| Event log lines | `user_id` column | Backend only (feeds that user's stats) |
| Leaderboard | GSI by `scenario_id` | Everyone, but only `username`, `score`, `ttrSeconds`, `endedAt` |

- `username` is copied onto the session item when it's created, so the leaderboard doesn't need a Cognito lookup. If a user changes their name in Cognito, old leaderboard rows keep the old name (accepted).
- Tests must cover the ownership checks: user B gets **404** for user A's session, dashboard, actions, logs and abandon.

## 4. Session lifecycle

### 4.1 States

```
            POST /api/sessions
                   │  (lock acquired, item written, execution started)
                   ▼
              ┌─────────┐   injector applied fault   ┌──────────────────┐
              │STARTING │ ─────────────────────────► │ INCIDENT_ACTIVE  │
              └─────────┘   (cross-repo, §8.3)       └──────────────────┘
                   │                                    │            │
       start error │              valid fix + healthy ×2│            │ timeout / abandon / error
                   ▼                                    ▼            ▼
              ┌─────────┐                         ┌──────────┐  ┌─────────┐
              │ FAILED  │                         │ RESOLVED │  │ FAILED  │
              └─────────┘                         └──────────┘  └─────────┘
```

`RESOLVED` and `FAILED` are terminal. Every transition is a DynamoDB **conditional update** (`#state = :expected`), so duplicate or late messages can't move a session backwards.

### 4.2 Full flow

1. **Start**: `POST /api/sessions { scenarioId }`
   1. The API acquires the global lock: Redis `SET lock:active-session <sessionId> NX PX <ttl>`. TTL = `warmupSeconds + maxResolveSeconds + 180` s. If the lock is taken, the API returns **409** `SESSION_BUSY` with `retryAfterSeconds` (from the lock's PTTL).
   2. `PutItem` the session (`state=STARTING`) with `attribute_not_exists(session_id)`.
   3. Appends a `SESSION_STARTED` event.
   4. `StartExecution` with `name = sessionId` (idempotent) and the input in §8.1.
   5. If step 2 or 4 fails, the API marks the session `FAILED`, releases the lock and returns 500.
   6. Returns **201** `{ sessionId }`.
2. **Warmup and fault**: Step Functions waits `warmupSeconds`, then sends the fault to SQS `faults`. The injector (infra repo) applies it and updates the session (§8.3) → `INCIDENT_ACTIVE`.
3. **Wait for fix**: Step Functions state `WaitForFix` (DynamoDB `updateItem.waitForTaskToken`) stores `task_token` on the item and waits up to `maxResolveSeconds`.
4. **User acts**: the SPA polls the dashboard. The user acknowledges, views logs and applies actions (§5). Actions are enqueued and the worker applies them in order (FIFO, group = sessionId).
5. **Resolution** (worker monitor loop): if the session is `INCIDENT_ACTIVE`, a valid fix was applied (`valid_fix_applied_at` set) and **every** mock service is healthy on 2 consecutive checks, then:
   1. compute TTD, TTR and score (`scoring`)
   2. append `RESOLVED` and `SCORED` events
   3. call `SendTaskSuccess(task_token, output §8.2)`
6. **Persist** (Step Functions): writes `state=RESOLVED`, the score fields and `ended_at`. Timeout or failure branches write `state=FAILED` and `ended_at`.
7. **End** (cross-repo, §8.4): on every terminal path, Step Functions sends `SESSION_ENDED` to `user-actions`. The worker then:
   1. flushes the event log to S3
   2. resets the mock system to the scenario `baseline`
   3. waits until it's healthy (max 60 s; logs a warning if not)
   4. releases the lock **only if it still holds this sessionId** (compare-and-delete Lua script)
   5. deletes the hot Redis keys

**Abandon**: `POST /api/sessions/:id/abandon` enqueues `ABANDON`. The worker calls `SendTaskFailure(task_token, "Abandoned")`, and the Step Functions failure branch continues from step 6.

## 5. Actions catalog (MVP)

| Action | Where it runs | Effect on mock system | Notes |
|---|---|---|---|
| `ACKNOWLEDGE` | worker | none | Sets `acknowledged_at` (first time only) → TTD |
| `VIEW_LOGS` | **api, synchronous** (`GET …/logs`) | none (reads last 100 lines) | Recorded as an event; not queued |
| `RESTART_DEPLOYMENT` | worker | patch `spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"]` | Target = deployment name |
| `SCALE_DEPLOYMENT` | worker | patch `deployments/scale` → `replicas` (1–3) | `params.replicas` required |
| `ROLLBACK` | **(planned)** | — | Not in MVP |
| `ABANDON` | worker | none | `SendTaskFailure` |
| `SESSION_ENDED` | worker | reset to baseline | **System message from Step Functions**, never accepted from HTTP |

An action is a **valid fix** if it matches an entry in `scenario.validFixes`: same `type` and `target`, and for scale, `replicas >= minReplicas`. Otherwise it counts as a wrong action (penalized), except `ACKNOWLEDGE` and `VIEW_LOGS`.

The API rejects (**422** `ACTION_NOT_ALLOWED`) action types not in `scenario.availableActions`, targets not in `scenario.targets`, and actions on sessions not in `INCIDENT_ACTIVE`. `ACKNOWLEDGE` is also allowed in `STARTING`, but doesn't count toward TTD until the fault is injected.

## 6. HTTP API

Base path `/api`. JSON only. All routes except health and `openapi.json` require `Authorization: Bearer <cognito access token>`.
Sessions are always read with `PK = caller's userId`, so another user's session id returns **404** (we never reveal it exists).

| Method & path | Request | Success | Errors |
|---|---|---|---|
| `GET /healthz` | — | 200 `{status:"ok"}` (process alive) | — |
| `GET /readyz` | — | 200 when DynamoDB, Redis and S3 are reachable | 503 |
| `GET /api/openapi.json` | — | 200 OpenAPI document | — |
| `GET /api/scenarios` | — | 200 `ScenarioSummary[]` | — |
| `GET /api/scenarios/:scenarioId` | — | 200 `ScenarioPublic` (no `validFixes`) | 404 |
| `POST /api/sessions` | `{ scenarioId }` | 201 `{ sessionId }` | 404 scenario, **409 `SESSION_BUSY`** `{retryAfterSeconds}` |
| `GET /api/sessions/:sessionId` | — | 200 `SessionView` | 404 |
| `GET /api/sessions/:sessionId/dashboard` | — | 200 `DashboardSnapshot` | 404 |
| `POST /api/sessions/:sessionId/actions` | `{ type, target?, params? }` | 202 `{ actionId }` | 404, 409 `SESSION_NOT_ACTIVE`, 422 `ACTION_NOT_ALLOWED` |
| `GET /api/sessions/:sessionId/logs?service=` | — | 200 `{ service, lines: string[] }` | 404, 409, 422 |
| `POST /api/sessions/:sessionId/abandon` | — | 202 | 404, 409 |
| `GET /api/me/sessions?limit=&cursor=` | — | 200 `{ items: SessionView[], nextCursor? }` | — |
| `GET /api/me/stats/:queryName` | `queryName ∈ score-over-time \| ttd-ttr-by-attempt` | 200 `{ rows: [...] }` | 404 unknown query, 504 Athena timeout |
| `GET /api/leaderboard/:scenarioId?limit=10` | — | 200 `LeaderboardEntry[]` | 404 |

**Error body** (always):
```json
{ "error": { "code": "SESSION_BUSY", "message": "A scenario is already running.", "details": { "retryAfterSeconds": 412 }, "requestId": "01J…" } }
```

**Key response shapes** (exact definitions are the zod schemas; this is a summary):
```ts
SessionView = { sessionId, scenarioId, state, createdAt, faultInjectedAt?, acknowledgedAt?, endedAt?,
                score?, ttdSeconds?, ttrSeconds?, wrongActions?, failureReason? }

DashboardSnapshot = {
  sessionId, state, generatedAt, elapsedSeconds,
  services: [{ name, desiredReplicas, readyReplicas,
               health: "healthy" | "degraded" | "down", latencyMs?,
               pods: [{ name, phase, ready, restarts, ageSeconds }] }],
  recentEvents: [{ ts, type, summary }],   // last 20
  availableActions: string[]
}
LeaderboardEntry = { rank, username, score, ttrSeconds, sessionId, endedAt }
```
The SPA polls `GET …/dashboard` every 2 s. If the snapshot is missing or older than 10 s, the API returns the last known one with `stale: true`, or a minimal snapshot built from DynamoDB.

## 7. Data

### 7.1 DynamoDB `Sessions` (owned by this repo; table created by infra)

| Attribute | Type | Written by | Notes |
|---|---|---|---|
| `user_id` (PK) | S | api | Cognito `sub` |
| `session_id` (SK) | S | api | ULID |
| `username` | S | api | from the token, for the leaderboard |
| `scenario_id` | S | api | |
| `state` | S | api / injector / Step Functions | §4.1 |
| `execution_arn` | S | api | |
| `task_token` | S | Step Functions | removed after use |
| `created_at` | S | api | ISO-8601 UTC |
| `fault_injected_at` | S | injector **(cross-repo)** | |
| `acknowledged_at` | S | worker | first ACKNOWLEDGE after the fault |
| `valid_fix_applied_at` | S | worker | first valid fix |
| `wrong_actions` | N | worker | atomic `ADD` |
| `actions_count` | N | worker | atomic `ADD` |
| `score`, `ttd_seconds`, `ttr_seconds` | N | Step Functions (from §8.2) | only when `RESOLVED` |
| `ended_at`, `failure_reason` | S | Step Functions | |
| `updated_at` | S | everyone | |

**GSI `Leaderboard`**: PK `scenario_id`, SK `score` (N). Sparse, because only `RESOLVED` items have `score`.
**Access patterns**: GetItem(user, session) · Query(user, newest first, paginated with `LastEvaluatedKey` → base64 cursor) · Query GSI by scenario, descending. **No scans.**
The worker needs `userId` to read an item, which is why every queue message carries `userId`.

### 7.2 Redis keys

| Key | Type | TTL | Purpose |
|---|---|---|---|
| `lock:active-session` | string (sessionId) | warmup + maxResolve + 180 s | Global lock (D-05) |
| `session:{id}:events` | list (JSON events) | 2 h | Event buffer until flush |
| `session:{id}:health` | string (consecutive healthy count) | 1 h | Resolution detection |
| `dashboard:{id}` | string (JSON snapshot) | 10 s, refreshed every 2 s | Polling target |
| `action:{actionId}` | string | 24 h | Idempotency (SET NX before applying) |
| `stats:{userId}:{query}` | string (JSON rows) | 5 min | Athena cache |
| `leaderboard:{scenarioId}` | string (JSON) | 60 s | Leaderboard cache |

Redis is a cache plus a lock. **Nothing durable lives only in Redis**, except the event buffer during a session (see DECISIONS, limitations).

### 7.3 S3 (`FILES_BUCKET`)

| Prefix | Written by | Content |
|---|---|---|
| `scenarios/{scenarioId}.json` | release workflow of this repo | Scenario definitions from `scenarios/` |
| `logs/year=YYYY/month=MM/day=DD/{sessionId}.ndjson` | worker | One event per line (§7.4); date = session `created_at` |
| `athena-results/` | Athena | Query output (lifecycle set by infra) |

### 7.4 Event line (contract with the Athena table in the infra repo)

```json
{"ts":"2026-10-22T19:05:02.120Z","user_id":"…","session_id":"…","scenario_id":"orders-down",
 "type":"ACTION","action":"SCALE_DEPLOYMENT","target":"orders","params":{"replicas":2},"valid":true,
 "score":null,"ttd_seconds":null,"ttr_seconds":null}
```
`type` ∈ `SESSION_STARTED | FAULT_INJECTED | ACKNOWLEDGED | ACTION | VIEW_LOGS | RESOLVED | FAILED | SCORED`.
Every line has the same keys (null when not applicable), so the Glue schema stays flat.

### 7.5 Scenario definition (`scenarios/*.json`)

```json
{
  "id": "orders-down",
  "title": "Orders service is not responding",
  "description": "Checkout requests are failing with 5xx.",
  "warmupSeconds": 20,
  "maxResolveSeconds": 600,
  "targets": ["gateway", "orders", "worker-svc"],
  "baseline": { "gateway": 1, "orders": 2, "worker-svc": 1 },
  "faults": [{ "type": "SCALE_TO_ZERO", "target": "orders" }],
  "availableActions": ["ACKNOWLEDGE", "VIEW_LOGS", "RESTART_DEPLOYMENT", "SCALE_DEPLOYMENT"],
  "validFixes": [{ "type": "SCALE_DEPLOYMENT", "target": "orders", "minReplicas": 1 }],
  "scoring": { "base": 1000, "perSecondTTD": 1, "perSecondTTR": 1, "perWrongAction": 25 }
}
```
Score = `max(0, base − perSecondTTD·TTD − perSecondTTR·TTR − perWrongAction·wrong)`. If the user never acknowledged, TTD = TTR.

## 8. Contracts with other repos (cross-repo)

### 8.1 Step Functions execution input (api → state machine)
```json
{ "userId": "…", "sessionId": "…", "scenarioId": "orders-down",
  "warmupSeconds": 20, "maxResolveSeconds": 600,
  "fault": { "faultId": "…", "type": "SCALE_TO_ZERO", "target": { "namespace": "mock", "deployment": "orders" } } }
```

### 8.2 `SendTaskSuccess` output (worker → state machine)
```json
{ "resolvedAt": "…", "ttdSeconds": 42, "ttrSeconds": 131, "wrongActions": 1, "actionsCount": 4, "score": 802 }
```
The state machine's `Persist` step writes these to the item.

### 8.3 Injector → session item
After applying a fault, the injector does a conditional `UpdateItem` on `Sessions`: `state=INCIDENT_ACTIVE`, `fault_injected_at=<now>`, condition `state = STARTING`. It also appends a `FAULT_INJECTED` event to `session:{id}:events` in Redis. The `faults` message therefore must include `userId` and `sessionId`.

### 8.4 `SESSION_ENDED` system message (state machine → `user-actions`)
Sent on **every** terminal path (success, timeout, abandon, error):
```json
{ "kind": "SYSTEM", "type": "SESSION_ENDED", "sessionId": "…", "userId": "…", "outcome": "RESOLVED" | "FAILED", "reason": "TIMEOUT" | "ABANDONED" | "ERROR" | null }
```
`MessageGroupId = sessionId`, `MessageDeduplicationId = sessionId + ":ended"`.

### 8.5 `user-actions` message (api → worker)
FIFO queue. `MessageGroupId = sessionId`, `MessageDeduplicationId = actionId`.
```json
{ "kind": "USER", "actionId": "…", "sessionId": "…", "userId": "…", "type": "SCALE_DEPLOYMENT", "target": "orders", "params": { "replicas": 2 }, "requestedAt": "…" }
```

### 8.6 What the infra repo provides
- Kubernetes RBAC in namespace `mock`:
  - **`api` ServiceAccount**: `get,list,watch` on `pods`, `deployments`; `get` on `pods/log`.
  - **`worker` ServiceAccount**: the same, plus `patch` on `deployments` and `deployments/scale`.
- NetworkPolicy: `app` → `mock` on the services' HTTP port (health checks).
- Env vars from §9 via ConfigMap; the images `api`/`worker` = this repo's image at a git-SHA tag.
- ALB health check on `/healthz`; CloudFront `/api/*` → ALB.

## 9. Configuration (env vars)

| Var | Used by | Example / default |
|---|---|---|
| `NODE_ENV` | both | `production` \| `development` \| `test` |
| `PORT` / `WORKER_HEALTH_PORT` | api / worker | `3000` / `3001` |
| `LOG_LEVEL` | both | `info` |
| `AWS_REGION` | both | `us-east-1` |
| `AWS_ENDPOINT_URL` | both | **local only**: `http://localhost:4566` |
| `SESSIONS_TABLE` | both | `Sessions` |
| `FILES_BUCKET` | both | `oncall-training-files-<acct>` |
| `USER_ACTIONS_QUEUE_URL` | both | |
| `STATE_MACHINE_ARN` | api | |
| `ATHENA_WORKGROUP` / `ATHENA_DATABASE` | api | `oncall-training` / `oncall_training` |
| `REDIS_URL` | both | `redis://localhost:6379` (`rediss://` on ElastiCache with TLS) |
| `COGNITO_USER_POOL_ID` / `COGNITO_CLIENT_ID` | api | |
| `AUTH_MODE` | api | `cognito` (default) \| `dev` (**refuses to start unless `NODE_ENV=development`**) |
| `MOCK_CLUSTER` | both | `kubernetes` (default) \| `fake` (in-memory, for local/frontend dev and tests) |
| `MOCK_NAMESPACE` | both | `mock` |
| `MOCK_HEALTH_URL_TEMPLATE` | worker | `http://{service}.mock.svc.cluster.local:8080/health` |
| `STATS_MODE` | api | `athena` (default) \| `fixture` (local; LocalStack Athena is a paid feature) |

## 10. Local development

`docker-compose.yml`:
- **LocalStack** with `dynamodb,s3,sqs,stepfunctions`. Init scripts in `local/init/` create the table, bucket and queues, upload `scenarios/`, and create the state machine from `local/statemachine.asl.json` (a copy of the infra repo's definition with local ARNs).
- **Redis**.

Ways to run, from least to most realistic:
1. `MOCK_CLUSTER=fake`, `AUTH_MODE=dev`, `STATS_MODE=fixture`: API + worker + compose. `scripts/dev-inject.ts` reads the LocalStack `faults` queue and applies the fault to the fake cluster (stands in for the injector).
2. Same, but with `MOCK_CLUSTER=kubernetes` against a **kind** cluster where the infra repo's mock system (and optionally the injector) is deployed.
3. AWS: deployed to EKS by the infra repo's manifests.

## 11. Failure handling

| Failure | Behavior |
|---|---|
| Duplicate SQS delivery | `action:{id}` SET NX → second copy is acknowledged and skipped |
| Worker crash mid-action | Message becomes visible again after the visibility timeout (60 s) and is retried; k8s patches are idempotent |
| Poison message | 3 receives → DLQ; logged with `sessionId` |
| Worker down during a session | Step Functions times out → `FAILED` → `SESSION_ENDED` is processed when the worker comes back; the lock TTL is the last resort |
| Redis restart | Dashboard rebuilds within 2 s; **lock and unflushed events are lost** (see limitations) |
| Athena slow | Poll up to 20 s, then 504 `STATS_TIMEOUT`; cached results are served if present |
| `SendTaskSuccess` with an expired token | `TaskTimedOut` is caught and logged; the session is already `FAILED` |
