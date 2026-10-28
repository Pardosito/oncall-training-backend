# Decisions, Limitations and Future Work

What we decided, why, what we gave up, and what we'd do with more time or a real AWS account.
Add a new entry whenever something is decided or changed; don't rewrite history. If a decision is replaced, mark it **Superseded by D-xx**.

**Status values:**

- **Decided**: settled.
- **Proposed**: our preferred option, but it needs another repo's owner to agree (usually infra / Ian).
- **Superseded**: replaced by a later decision.

---

## 1. Decision log

| ID   | Date       | Decision                                                                             | Status                          |
| ---- | ---------- | ------------------------------------------------------------------------------------ | ------------------------------- |
| D-01 | 2026-10-22 | Split into three repos: backend, frontend, infra                                     | Decided                         |
| D-02 | 2026-10-22 | TypeScript (ESM) + Express 5 + pnpm + Vitest                                         | Decided                         |
| D-03 | 2026-10-22 | Feature modules with factory-function dependency injection                           | Decided                         |
| D-04 | 2026-10-22 | OpenAPI generated from zod is the frontend contract                                  | Decided                         |
| D-05 | 2026-10-22 | Only one active session in the whole system (Redis global lock)                      | Decided                         |
| D-06 | 2026-10-22 | Two processes from one image: `api` and `worker`                                     | Decided                         |
| D-07 | 2026-10-22 | The worker monitors the mock system and detects resolution                           | Decided                         |
| D-08 | 2026-10-22 | The worker runs as a single replica                                                  | Decided                         |
| D-09 | 2026-10-22 | Step Functions waits for the fix with the task-token pattern                         | Decided                         |
| D-10 | 2026-10-22 | Score computed in backend code, passed to Step Functions                             | Decided                         |
| D-11 | 2026-10-22 | Step Functions sends `SESSION_ENDED` to `user-actions` on every terminal path        | **Proposed** (infra)            |
| D-12 | 2026-10-22 | The injector marks the session `INCIDENT_ACTIVE` and appends `FAULT_INJECTED`        | **Proposed** (infra)            |
| D-13 | 2026-10-22 | `user-actions` is a FIFO queue grouped by session                                    | **Proposed** (infra)            |
| D-14 | 2026-10-22 | Dashboard updates by polling every 2 s (no WebSockets/SSE)                           | Decided                         |
| D-15 | 2026-10-22 | `VIEW_LOGS` is a synchronous API call, not a queued action                           | Decided                         |
| D-16 | 2026-10-22 | Session ownership enforced by the partition key; other users' sessions → 404         | Decided                         |
| D-17 | 2026-10-22 | AWS credentials come from the node role (`LabRole`); no IRSA or Pod Identity         | Decided (forced by Learner Lab) |
| D-18 | 2026-10-22 | LocalStack for local AWS; dev auth, fake cluster and fixture stats as local switches | Decided                         |
| D-19 | 2026-10-22 | Scenario definitions live in this repo and are synced to S3                          | Decided                         |
| D-20 | 2026-10-22 | Event log buffered in Redis during a session, flushed to S3 as NDJSON at the end     | Decided                         |
| D-21 | 2026-10-22 | No CORS: the API is only reached through the SPA's CloudFront origin                 | Decided                         |
| D-22 | 2026-10-22 | Docs written in English                                                              | Decided                         |
| D-23 | 2026-10-22 | Per-user separation via Cognito `sub`; no users table; no editable profiles          | Decided                         |

---

## 2. Decisions in detail

### D-01 · Three repos instead of a monorepo

**Why:** each teammate owns a clear area (JP: backend/data, Ian: infra/orchestration), with separate CI pipelines and independent deploys. It also reads well on a CV.
**Trade-off:** shared contracts can drift between repos. We mitigate it with D-04 (generated OpenAPI) and the cross-repo contract section in ARCHITECTURE §8.
**Replaces:** the earlier monorepo plan (`AGENTS.md` of 2026-10-14).

### D-02 · TypeScript (ESM) + Express 5 + pnpm + Vitest

**Why:** the team knows Express. Version 5 is the current stable release and forwards async errors automatically, which removes a classic Express 4 bug class. ESM is the modern Node default. pnpm is fast and strict about undeclared dependencies. Vitest is fast and works with ESM/TS without configuration.
**Alternatives considered:** Fastify (faster, schema-first; but less familiar to the team), NestJS (too much framework for this size), Jest (slower, ESM support is still awkward).

### D-03 · Feature modules + factory DI

**Why:** the code is grouped by what it does (sessions, actions, dashboard…), so a change usually touches one folder. Passing dependencies into factory functions makes every service unit-testable with fakes, without a DI container.
**Trade-off:** composition roots (`app.ts`, `worker.ts`) have some wiring boilerplate.

### D-04 · OpenAPI from zod

**Why:** one source of truth. The same zod schema validates requests at runtime, generates TypeScript types, and produces `openapi.json`, from which the frontend generates its client types (`openapi-typescript`). CI fails if the spec is stale.
**Alternatives considered:** a shared npm package (needs publishing and versioning); hand-copied types (drift guaranteed).

### D-05 · One active session at a time (global lock)

**Why:** there's a single mock system in the cluster. Two concurrent sessions would inject faults into the same deployments, and one user's fix would resolve another user's incident. A global lock is the simplest correct behavior for the MVP and for demos.
**How:** Redis `SET lock:active-session <sessionId> NX PX <ttl>` when starting. TTL = warmup + max resolve time + 3 min, as a safety net. Released by the worker after reset, using compare-and-delete. A second user gets `409 SESSION_BUSY` with `retryAfterSeconds`.
**Trade-off:** no concurrency. See limitations L-01 and L-04, and improvements F-01 and F-02.

### D-06 · `api` + `worker` from one image

**Why:** the HTTP server must answer fast and stay stateless (2 replicas behind the ALB). Consuming the queue, polling Kubernetes and detecting resolution are long-running background jobs. Separating them means a slow k8s call never blocks HTTP, and each process scales independently. One image keeps builds and versions simple.

### D-07 · The worker detects resolution

**Why:** the worker already polls the mock system every 2 s to build the dashboard snapshot, so it has the information needed to decide "it's healthy now". Doing it in Step Functions would need a polling loop of Lambdas or Wait states (more cost and complexity). Doing it in the API would run the check in 2 replicas.
**Rule:** a valid fix was applied **and** all mock services are healthy on 2 consecutive checks. Requiring a valid fix stops "healthy by luck" from counting. Two checks avoid flapping.

### D-08 · Single worker replica

**Why:** with one session at a time (D-05) there's no throughput need. A second monitor would duplicate snapshots and could call `SendTaskSuccess` twice (harmless but noisy).
**Trade-off:** the worker is a single point of failure. Kubernetes restarts it in seconds, and SQS keeps the messages. See L-05 and F-07.

### D-09 · Task-token callback pattern in Step Functions

**Why:** the state machine has to wait an unknown amount of time for a human. `.waitForTaskToken` pauses the execution for free (Standard workflow, billed by state transitions) until we call `SendTaskSuccess`/`SendTaskFailure`, with a built-in timeout for the "user never fixes it" case. The token is stored on the session item by the `WaitForFix` state, so the worker can find it.

### D-10 · Score computed in the backend

**Why:** scoring is business logic that needs unit tests and will change. In TypeScript it's a pure function with tests. Step Functions just persists the result it receives in the task output. Without this, we'd need a Lambda (another deploy unit) or complex ASL intrinsic functions.

### D-11 · `SESSION_ENDED` system message (Proposed, needs infra)

**Why:** cleanup (flush logs, reset the mock system, release the lock) must happen on **every** ending: success, timeout, abandon or error. Several of those endings happen inside Step Functions, where the backend can't see them. If Step Functions sends one message on all terminal paths, cleanup has exactly one code path, in the worker.
**Alternative:** the worker periodically checks for ended sessions (slower, more code).

### D-12 · The injector updates the session (Proposed, needs infra)

**Why:** TTD and TTR are measured from the moment the fault is **actually applied**, and only the injector knows that moment. A conditional update (`state = STARTING`) makes it idempotent.
**Consequence:** `faults` messages must carry `userId` and `sessionId`, and the injector needs DynamoDB and Redis access (LabRole already allows it).

### D-13 · FIFO `user-actions` queue (Proposed, needs infra)

**Why:** action order matters within a session ("scale to 0" then "scale to 2" ≠ the reverse). FIFO with `MessageGroupId = sessionId` guarantees order per session and adds dedup by `actionId`.
**Trade-off:** lower throughput than standard queues, which is irrelevant at our scale.

### D-14 · Polling instead of push

**Why:** a 2 s poll on a cached Redis snapshot is cheap, simple and works through CloudFront and the ALB without extra configuration. WebSockets would need sticky connections, timeouts tuned on CloudFront and the ALB, or API Gateway WebSockets.
**Trade-off:** up to about 2 s of latency in the UI, which is acceptable for a training exercise.

### D-15 · `VIEW_LOGS` is synchronous

**Why:** the user expects to see the logs immediately, and it changes nothing in the mock system, so ordering doesn't matter. It's still recorded as an event, so it shows up in analytics.

### D-16 · Ownership through the partition key → 404

**Why:** every session read uses `PK = caller's userId`, so a user can't read another user's session even if they guess the id, and no extra authorization check is needed. Returning 404 (not 403) doesn't reveal that the session exists.

### D-17 · Node role (`LabRole`) for AWS credentials

**Why:** AWS Academy Learner Lab doesn't allow creating IAM roles or OIDC providers, so IRSA and EKS Pod Identity are impossible. Pods use the node's instance role through IMDS, and the SDK's default credential chain picks it up with no code changes.
**Trade-off:** no IAM isolation between workloads (L-02). The code never passes credentials, so moving to IRSA later is configuration only (F-04).

### D-18 · Local development setup

**Why:** develop without paying for EKS, ElastiCache or the ALB, and without lab credentials that expire. LocalStack's free tier covers DynamoDB, S3, SQS and Step Functions. Cognito and Athena are paid LocalStack features, so we use `AUTH_MODE=dev` and `STATS_MODE=fixture`. `MOCK_CLUSTER=fake` lets the backend and frontend run without any Kubernetes; kind gives a realistic option.
**Risk:** LocalStack's Step Functions support for `.waitForTaskToken` with DynamoDB has to be verified early. Fallback: a small dev orchestrator script (O-02).

### D-19 · Scenarios live in the backend repo

**Why:** the backend is the main consumer, owns the zod schema that validates them, and its tests use them. The release workflow uploads `scenarios/*.json` to S3.

### D-20 · Event log: Redis buffer → S3 NDJSON

**Why:** writing one S3 object per event is slow and makes many small files, which is bad for Athena. Buffering per session and writing one NDJSON file at the end gives exactly one object per session, partitioned by date.
**Trade-off:** if Redis is lost mid-session, that session's detailed events are lost (L-03). The score and timestamps are still safe in DynamoDB.

### D-21 · No CORS

**Why:** CloudFront serves both the SPA (`/*`) and the API (`/api/*`) from one domain, so the browser never makes a cross-origin call. Adding CORS middleware would hide a misrouted request instead of surfacing it.

### D-22 · English docs

**Why:** they match the earlier docs, work best for the CV, and are what agents handle most reliably.

### D-23 · Per-user separation without a users table

**Why:** scoring, history and stats must be per user, but the MVP doesn't need profile data. Cognito already stores accounts, so the token's `sub` is a stable `user_id` for DynamoDB keys, Athena filters and Redis keys. The display `username` is copied onto each session for the leaderboard. A users table would only duplicate Cognito.
**Out of scope:** editing profile data, avatars, settings, roles and admin views.
**Future:** if profiles are ever needed, add a `Users` table keyed by `user_id`; existing data doesn't change.

---

## 3. Current limitations

| ID   | Limitation                                                         | Impact                                                                       | Mitigation now                                                                           |
| ---- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| L-01 | Only one session can run at a time                                 | Other users wait (409) up to about 13 min in the worst case                  | `retryAfterSeconds` so the UI can show a countdown                                       |
| L-02 | All pods share `LabRole`; no per-service IAM permissions           | A compromised pod could reach any AWS resource LabRole allows                | Namespaces, k8s RBAC, NetworkPolicies; no user input reaches AWS calls unvalidated       |
| L-03 | Session event buffer lives only in Redis until the session ends    | Redis restart mid-session → that session's analytics are lost                | DynamoDB keeps score and key timestamps; ElastiCache restarts are rare                   |
| L-04 | The global lock lives in Redis                                     | If Redis restarts during a session, a second session could start and collide | Short demo windows; future DynamoDB-based lock (F-02)                                    |
| L-05 | Single worker replica                                              | Seconds of downtime on restart; actions are delayed, not lost                | Kubernetes restarts it; SQS retains messages; the Step Functions timeout is the backstop |
| L-06 | Dashboard latency of about 2 s (polling)                           | UI isn't instant                                                             | Acceptable for training                                                                  |
| L-07 | Athena queries take a few seconds                                  | Stats page loads slowly the first time                                       | 5-min Redis cache; queries filtered by partition                                         |
| L-08 | Lab credentials expire each session                                | CI deploy secrets must be refreshed manually                                 | Deploy only on demand; CI tests never need AWS                                           |
| L-09 | One scenario, two fix actions, simple health check (`/health` 2xx) | Limited training value                                                       | Scope is intentional for the MVP                                                         |
| L-10 | Linear scoring                                                     | Doesn't reward good diagnosis, only speed and accuracy                       | Weights live in the scenario JSON, easy to tune                                          |
| L-11 | No rate limiting on the API                                        | A user could spam actions                                                    | One session at a time; actions are validated and cheap                                   |
| L-12 | Leaderboard shows the Cognito `username`                           | If it's an email, it leaks the email                                         | Use a preferred-username or nickname claim (O-04)                                        |
| L-13 | Mock-system reset after a session can fail                         | Next session would start on a broken system                                  | Worker waits for healthy (60 s) and logs an error; the lock is released anyway           |

---

## 4. Future improvements

| ID   | Improvement                                                                                                                             | Removes / helps                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| F-01 | **One mock system per session**: create namespace `mock-<sessionId>` from a template, delete it at the end; ResourceQuota per namespace | L-01, L-04; real multi-user         |
| F-02 | Lock in DynamoDB (conditional put with TTL attribute) or a waiting-room queue with position updates                                     | L-04, nicer UX for L-01             |
| F-03 | Server-Sent Events (or API Gateway WebSockets) for the dashboard                                                                        | L-06                                |
| F-04 | IRSA / EKS Pod Identity with one least-privilege role per ServiceAccount (Terraform already parameterized)                              | L-02                                |
| F-05 | Durable event stream: Kinesis Data Firehose → S3 Parquet, Glue table on Parquet                                                         | L-03, L-07 (cheaper, faster Athena) |
| F-06 | OpenTelemetry tracing (API → SQS → worker → Step Functions), CloudWatch dashboards and alarms                                           | Debuggability; nice for the CV      |
| F-07 | Multiple worker replicas with leader election (Kubernetes `Lease`) for the monitor loop                                                 | L-05                                |
| F-08 | More scenarios (crash loop, bad config, latency injection, dependency down), scenario editor                                            | L-09                                |
| F-09 | Richer scoring: partial credit, hint penalties, diagnosis questions, auto-generated post-mortem                                         | L-10                                |
| F-10 | Per-user rate limiting (Redis token bucket)                                                                                             | L-11                                |
| F-11 | Contract tests between repos (Pact or schema checks on `faults` / `SESSION_ENDED`)                                                      | Cross-repo drift                    |
| F-12 | E2E tests in CI against kind + LocalStack                                                                                               | Confidence before deploys           |
| F-13 | GitHub OIDC deploy role (real AWS account)                                                                                              | L-08                                |

---

## 5. Open questions

| ID   | Question                                                                                                                                    | Owner | Blocks             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------ |
| O-01 | Infra agrees to D-11, D-12, D-13 and the RBAC in ARCHITECTURE §8.6?                                                                         | Ian   | Week 4 integration |
| O-02 | Does LocalStack Step Functions support `dynamodb:updateItem.waitForTaskToken`? If not, write a dev orchestrator script                      | JP    | Local full loop    |
| O-03 | Who rolls out new images to EKS (infra repo workflow vs. `kubectl set image` from this repo's release workflow)?                            | Both  | Week 3 deploy      |
| O-04 | Which Cognito claim do we show on the leaderboard (`preferred_username`, `nickname`)? Is it in the access token or do we need the ID token? | JP    | Leaderboard        |
| O-05 | ElastiCache with TLS (`rediss://`) and/or AUTH token in the Learner Lab?                                                                    | Ian   | Redis config       |
