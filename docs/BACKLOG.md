# Backend Backlog

Issue backlog for `oncall-training-backend`, derived from `AGENTS.md`, `ARCHITECTURE.md`, `CONVENTIONS.md` and `DECISIONS.md`.
Backend scope only. Where an issue depends on another repo, it says so and stops at the contract.

**How to read it**

- One issue = one PR, one concern (CONVENTIONS §16). If an issue grows, split it.
- `Depends on` lists issues that must merge first. Issues with no dependency between them can be done in parallel.
- Every issue that adds or changes a contract must also run `pnpm openapi` and update `ARCHITECTURE.md` (AGENTS §7.4).
- "Unit tests" means Vitest with fakes, no Docker. "Integration tests" means against docker-compose (LocalStack + Redis).

**Milestones**

| Milestone                   | Goal                                                                             | Due            |
| --------------------------- | -------------------------------------------------------------------------------- | -------------- |
| M0 · Bootstrap              | Repo tooling, CI, skeleton                                                       | Tue Oct 27     |
| M1 · Deployable             | Platform layer, health endpoints, Docker image, api + worker runnable in EKS     | **Thu Oct 29** |
| M2 · Sessions & actions     | Auth, scenarios, sessions, orchestration, actions, mock-cluster, worker consumer | **Thu Nov 19** |
| M3 · Dashboard & resolution | Monitor loop, dashboard snapshot, scoring, resolution, cleanup                   | **Thu Nov 19** |
| M4 · Stats & leaderboard    | Athena stats, leaderboard                                                        | **Thu Nov 26** |
| M5 · Finish                 | E2E happy path, hardening, docs, demo                                            | **Thu Nov 26** |

**Labels:** type (`chore`, `feat`, `test`, `ci`, `build`, `docs`, `spike`), area (`area:platform`, `area:auth`, `area:scenarios`, `area:sessions`, `area:orchestration`, `area:actions`, `area:mock-cluster`, `area:worker`, `area:events`, `area:dashboard`, `area:scoring`, `area:stats`, `area:leaderboard`, `area:local-dev`), plus `cross-repo` when another repo's owner must agree or act.

---

## M0 · Bootstrap

### BE-001 · docs: move ARCHITECTURE, CONVENTIONS and DECISIONS into docs/

**Labels:** `docs` · **Milestone:** M0 · **Depends on:** —

`AGENTS.md` links to `docs/ARCHITECTURE.md`, `docs/CONVENTIONS.md` and `docs/DECISIONS.md`, but the files are at the repo root.

**Acceptance criteria**

- [ ] The three files are moved to `docs/` with `git mv` (history kept).
- [ ] All cross-links in `AGENTS.md` and inside the docs resolve.
- [ ] `BACKLOG.md` moved to `docs/BACKLOG.md`.

### BE-002 · chore: initialize package.json for pnpm, ESM and Node 22

**Labels:** `chore` · **Milestone:** M0 · **Depends on:** —

**Acceptance criteria**

- [ ] `package.json` with `"type": "module"`, `"engines": { "node": ">=22" }`, `"packageManager": "pnpm@<version>"`, `"private": true`.
- [ ] `.nvmrc` (or `.node-version`) set to `22`.
- [ ] `pnpm-lock.yaml` committed.
- [ ] Only dev tooling installed in this issue (`typescript`, `tsx`, `@types/node`); runtime deps come with the issues that need them.

### BE-003 · chore: add tsconfig per CONVENTIONS §1

**Labels:** `chore` · **Milestone:** M0 · **Depends on:** BE-002

**Acceptance criteria**

- [ ] `tsconfig.json`: `strict`, `module`/`moduleResolution: NodeNext`, `target: ES2023`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: false`, `outDir: dist`, `rootDir: src`.
- [ ] `tsconfig.build.json` that excludes `*.test.ts` and `test/`.
- [ ] `pnpm typecheck` (`tsc --noEmit`) and `pnpm build` (`tsc -p tsconfig.build.json`) scripts.

### BE-004 · chore: configure ESLint with typescript-eslint (type-checked)

**Labels:** `chore` · **Milestone:** M0 · **Depends on:** BE-003

**Acceptance criteria**

- [ ] Flat config `eslint.config.js` using `recommended-type-checked`.
- [ ] Rules on: `@typescript-eslint/no-floating-promises`, `@typescript-eslint/consistent-type-imports`, `no-console`, `import/no-default-export` (or equivalent).
- [ ] `pnpm lint` passes on the skeleton.

### BE-005 · chore: configure Prettier

**Labels:** `chore` · **Milestone:** M0 · **Depends on:** BE-002

**Acceptance criteria**

- [ ] `.prettierrc` with `printWidth: 100`, defaults otherwise; `.prettierignore` covers `dist/`, `openapi/openapi.json`, `pnpm-lock.yaml`.
- [ ] `eslint-config-prettier` so ESLint and Prettier don't conflict.
- [ ] `pnpm format` and `pnpm format:check` scripts.

### BE-006 · chore: configure Vitest with unit and integration projects

**Labels:** `chore` `test` · **Milestone:** M0 · **Depends on:** BE-003

**Acceptance criteria**

- [ ] `pnpm test` runs `src/**/*.test.ts` only (no Docker needed).
- [ ] `pnpm test:integration` runs `test/integration/**/*.int.test.ts`.
- [ ] One placeholder test passes in each project.

### BE-007 · chore: add .gitignore, .editorconfig and .env.example skeleton

**Labels:** `chore` · **Milestone:** M0 · **Depends on:** —

**Acceptance criteria**

- [ ] `.gitignore` covers `node_modules`, `dist`, `.env`, `.env.*` (but not `.env.example`), coverage, OS files.
- [ ] `.editorconfig` (2 spaces, LF, final newline).
- [ ] `.env.example` lists every var in ARCHITECTURE §9 with local defaults and **no secrets**.

### BE-008 · chore: create source skeleton and entrypoints

**Labels:** `chore` · **Milestone:** M0 · **Depends on:** BE-003

Lay out the folders from AGENTS §6 so later issues only add files.

**Acceptance criteria**

- [ ] `src/api.ts`, `src/worker.ts`, `src/app.ts` exist with minimal stubs (logging "not implemented" is fine).
- [ ] Empty folders kept with an `index.ts` per module listed in ARCHITECTURE §3 and `src/platform/`.
- [ ] `pnpm dev` (`tsx watch src/api.ts`) and `pnpm dev:worker` (`tsx watch src/worker.ts`) scripts start without errors.

### BE-009 · ci: add GitHub Actions workflow for lint, typecheck and unit tests

**Labels:** `ci` · **Milestone:** M0 · **Depends on:** BE-004, BE-005, BE-006

**Acceptance criteria**

- [ ] `.github/workflows/ci.yml` runs on PRs and pushes to `main`.
- [ ] Steps: pnpm setup with cache, `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`.
- [ ] No AWS credentials in the workflow.

### BE-010 · chore: add PR and issue templates

**Labels:** `chore` `docs` · **Milestone:** M0 · **Depends on:** —

**Acceptance criteria**

- [ ] `.github/pull_request_template.md` with the sections from CONVENTIONS §16: what, why, how tested, contract change (frontend/infra action needed?).
- [ ] A simple issue template (context, acceptance criteria).

### BE-011 · docs: write README with project summary and quickstart

**Labels:** `docs` · **Milestone:** M0 · **Depends on:** BE-001

**Acceptance criteria**

- [ ] One-paragraph description, link to the other two repos, link to `AGENTS.md` and `docs/`.
- [ ] Quickstart with the commands from AGENTS §5 (marked "coming soon" where not yet implemented).

---

## M1 · Deployable (platform layer + health + image)

### BE-012 · feat(config): define env schema with zod and load it once

**Labels:** `feat` `area:platform` · **Milestone:** M1 · **Depends on:** BE-008

**Acceptance criteria**

- [ ] `src/config/` exports a zod schema covering every var in ARCHITECTURE §9, with defaults and coercion (ports to numbers, enums for `NODE_ENV`, `AUTH_MODE`, `MOCK_CLUSTER`, `STATS_MODE`).
- [ ] `loadConfig(env)` returns a typed, frozen `Config`; invalid or missing values throw an error listing every failing variable.
- [ ] Vars needed only by one process (for example `STATE_MACHINE_ARN` for the api) are validated so the worker doesn't need them. Split into `ApiConfig`/`WorkerConfig` or make them optional with a per-process check.
- [ ] Unit tests: valid env, missing required var, bad enum value.

### BE-013 · feat(config): refuse AUTH_MODE=dev outside development

**Labels:** `feat` `area:platform` `area:auth` · **Milestone:** M1 · **Depends on:** BE-012

**Acceptance criteria**

- [ ] `loadConfig` throws when `AUTH_MODE=dev` and `NODE_ENV !== "development"`.
- [ ] Unit tests for both cases.

### BE-014 · feat(platform): add pino logger with redaction

**Labels:** `feat` `area:platform` · **Milestone:** M1 · **Depends on:** BE-012

**Acceptance criteria**

- [ ] `src/platform/logger.ts` exports one logger configured from `LOG_LEVEL`, JSON output.
- [ ] Redacts `req.headers.authorization`, `req.headers.cookie`, and any `taskToken`/`task_token` field.
- [ ] `pino-pretty` only in development (dev dependency, not in the prod image).
- [ ] Unit test: a logged object containing an auth header and a task token comes out redacted.

### BE-015 · feat(platform): add AppError and error helpers

**Labels:** `feat` `area:platform` · **Milestone:** M1 · **Depends on:** BE-008

**Acceptance criteria**

- [ ] `AppError(code, httpStatus, message, details?)` in `src/platform/errors.ts`.
- [ ] Helpers: `notFound()`, `conflict(code, message, details?)`, `unprocessable(code, message, details?)`, `unavailable()`, `gatewayTimeout(code)`.
- [ ] Unit tests for each helper's status and code.

### BE-016 · feat(platform): add Clock abstraction

**Labels:** `feat` `area:platform` · **Milestone:** M1 · **Depends on:** BE-008

**Acceptance criteria**

- [ ] `Clock` type (`now(): Date`), `systemClock`, and `createFixedClock(date)` with an `advance(seconds)` helper for tests.

### BE-017 · feat(http): add request id middleware

**Labels:** `feat` `area:platform` · **Milestone:** M1 · **Depends on:** BE-008

**Acceptance criteria**

- [ ] Generates a ULID per request (or reuses a valid incoming `x-request-id`), stores it on `res.locals.requestId` and sends it back as `x-request-id`.
- [ ] Unit test with supertest.

### BE-018 · feat(http): add central error handler and 404 handler

**Labels:** `feat` `area:platform` · **Milestone:** M1 · **Depends on:** BE-015, BE-017, BE-014

**Acceptance criteria**

- [ ] `AppError` → its status and code; `ZodError` → 400 `VALIDATION_ERROR` with issue paths in `details`; anything else → 500 `INTERNAL`.
- [ ] Body always has the shape in ARCHITECTURE §6, including `requestId`.
- [ ] No stack traces or upstream messages in the response; the full error is logged.
- [ ] Unknown routes → 404 `NOT_FOUND` in the same shape.
- [ ] Unit tests for each mapping.

### BE-019 · feat(http): add zod validate() middleware

**Labels:** `feat` `area:platform` · **Milestone:** M1 · **Depends on:** BE-018

**Acceptance criteria**

- [ ] `validate({ params?, query?, body? })` parses with zod and stores the result in `res.locals.input`; never assigns to `req.query` (read-only in Express 5).
- [ ] Typed helper (`getInput<T>(res)` or similar) so routes read parsed values without casts.
- [ ] Invalid input → 400 `VALIDATION_ERROR` via the error handler.
- [ ] Unit tests.

### BE-020 · feat(app): build createApp with the standard middleware order

**Labels:** `feat` `area:platform` · **Milestone:** M1 · **Depends on:** BE-017, BE-018, BE-014

**Acceptance criteria**

- [ ] `createApp(deps)` in `src/app.ts`, order per CONVENTIONS §4: request id → pino-http → `express.json({ limit: "100kb" })` → health routes → auth → routers → 404 → error handler.
- [ ] `app.disable("x-powered-by")`, `app.set("trust proxy", 2)`.
- [ ] **No `cors`**.
- [ ] pino-http uses the request id and the shared logger.
- [ ] Unit test: oversize body → 413 in the standard error shape.

### BE-021 · feat(health): add GET /healthz

**Labels:** `feat` `area:platform` · **Milestone:** M1 · **Depends on:** BE-020

**Acceptance criteria**

- [ ] `GET /healthz` → 200 `{ status: "ok" }`, no dependency checks, no auth.
- [ ] Supertest unit test.

### BE-022 · feat(platform): create AWS SDK client singletons

**Labels:** `feat` `area:platform` · **Milestone:** M1 · **Depends on:** BE-012

**Acceptance criteria**

- [ ] `src/platform/aws.ts` creates DynamoDB (+ `DynamoDBDocumentClient` with `removeUndefinedValues: true`), S3, SQS, SFN and Athena clients from config.
- [ ] `region` from `AWS_REGION`; `endpoint` only when `AWS_ENDPOINT_URL` is set; S3 uses `forcePathStyle` with LocalStack.
- [ ] **No `credentials` option anywhere** (AGENTS §7.3).
- [ ] Only the per-service packages are installed (`@aws-sdk/client-*`, `@aws-sdk/lib-dynamodb`).

### BE-023 · feat(platform): add Redis client

**Labels:** `feat` `area:platform` · **Milestone:** M1 · **Depends on:** BE-012, BE-014

**Acceptance criteria**

- [ ] `src/platform/redis.ts` creates an ioredis client from `REDIS_URL`; `rediss://` enables TLS.
- [ ] Connection errors are logged, not thrown unhandled; `closeRedis()` for shutdown.

### BE-024 · feat(health): add GET /readyz with dependency checks

**Labels:** `feat` `area:platform` · **Milestone:** M1 · **Depends on:** BE-021, BE-022, BE-023

**Acceptance criteria**

- [ ] Checks DynamoDB (`DescribeTable` on `SESSIONS_TABLE`), Redis (`PING`) and S3 (`HeadBucket` on `FILES_BUCKET`) in parallel, each with a short timeout.
- [ ] 200 when all pass; 503 with which check failed (no AWS error text).
- [ ] Checks are injected so unit tests use fakes.
- [ ] Note in the PR: `DescribeTable` and `HeadBucket` must be allowed for LabRole (they are by default).

### BE-025 · feat(api): wire api.ts entrypoint with graceful shutdown

**Labels:** `feat` `area:platform` · **Milestone:** M1 · **Depends on:** BE-024

**Acceptance criteria**

- [ ] `src/api.ts` loads config, builds real deps, calls `createApp`, listens on `PORT`.
- [ ] On `SIGTERM`/`SIGINT`: stop accepting connections, wait for in-flight requests (bounded), close Redis, exit 0.
- [ ] Startup and shutdown are logged at info.

### BE-026 · feat(worker): wire worker.ts entrypoint with health server

**Labels:** `feat` `area:worker` · **Milestone:** M1 · **Depends on:** BE-012, BE-014, BE-023

**Acceptance criteria**

- [ ] `src/worker.ts` loads config, starts a tiny HTTP server on `WORKER_HEALTH_PORT` with `GET /healthz` (200 while loops are running).
- [ ] Holds a root `AbortController`; `SIGTERM` aborts it, closes Redis and exits 0 (loops are added later).

### BE-027 · build: add multi-stage Dockerfile and .dockerignore

**Labels:** `build` · **Milestone:** M1 · **Depends on:** BE-025, BE-026

**Acceptance criteria**

- [ ] Stages per CONVENTIONS §15: `deps` (`pnpm fetch`), `build` (`tsc`), `runtime` (`node:22-alpine`, prod deps only, `USER node`).
- [ ] Default `CMD ["node", "dist/api.js"]`; `node dist/worker.js` works as an override.
- [ ] `.dockerignore` excludes `node_modules`, `.git`, tests, `.env*`.
- [ ] Image builds and `/healthz` answers locally with `docker run`.

### BE-028 · ci: build the Docker image in CI

**Labels:** `ci` `build` · **Milestone:** M1 · **Depends on:** BE-027, BE-009

**Acceptance criteria**

- [ ] CI job runs `docker build` (no push) on every PR.

### BE-029 · ci: add release workflow that pushes the image to ECR

**Labels:** `ci` `build` `cross-repo` · **Milestone:** M1 · **Depends on:** BE-028

**Acceptance criteria**

- [ ] `.github/workflows/release.yml`, `workflow_dispatch` only (Learner Lab credentials rotate, L-08).
- [ ] Reads short-lived lab credentials from repo secrets; tags the image with the git SHA; never `latest`.
- [ ] ECR repository name agreed with infra (infra creates it).
- [ ] README documents how to refresh the secrets before running it.

### BE-030 · docs: send infra the deployment contract for api and worker

**Labels:** `docs` `cross-repo` · **Milestone:** M1 · **Depends on:** BE-027

The Oct 29 deliverable needs infra's Deployments. Write down what they need and get it confirmed. No manifests in this repo.

**Acceptance criteria**

- [ ] Comment or doc for Ian listing: image name and tag scheme, commands for api and worker, ports, liveness/readiness paths (`/healthz`, `/readyz`, worker `:3001/healthz`), env vars from ARCHITECTURE §9, replica counts (api 2, worker 1), RBAC from ARCHITECTURE §8.6.
- [ ] Resolve **O-03** (who rolls out images) and record the answer in DECISIONS.
- [ ] Resolve **O-05** (Redis TLS / AUTH) and confirm `REDIS_URL` format.

---

## M1/M2 · Local development environment

### BE-031 · chore(local): add docker-compose with LocalStack and Redis

**Labels:** `chore` `area:local-dev` · **Milestone:** M1 · **Depends on:** BE-007

**Acceptance criteria**

- [ ] `docker-compose.yml` with LocalStack (`SERVICES=dynamodb,s3,sqs,stepfunctions`) on 4566 and Redis on 6379, both with healthchecks.
- [ ] `local/init/` mounted as LocalStack ready hooks (`/etc/localstack/init/ready.d`).
- [ ] `.env.example` defaults point at these (`AWS_ENDPOINT_URL=http://localhost:4566`, dummy keys).

### BE-032 · chore(local): init script that creates the Sessions table and Leaderboard GSI

**Labels:** `chore` `area:local-dev` · **Milestone:** M1 · **Depends on:** BE-031

**Acceptance criteria**

- [ ] Table `Sessions`: PK `user_id` (S), SK `session_id` (S); GSI `Leaderboard` PK `scenario_id` (S), SK `score` (N); on-demand billing.
- [ ] Idempotent (safe to re-run).
- [ ] Shape matches what infra's Terraform creates (confirm with Ian; `cross-repo`).

### BE-033 · chore(local): init script that creates the files bucket

**Labels:** `chore` `area:local-dev` · **Milestone:** M1 · **Depends on:** BE-031

**Acceptance criteria**

- [ ] Creates `FILES_BUCKET` and uploads `scenarios/*.json` to `scenarios/`. Idempotent.

### BE-034 · chore(local): init script that creates the SQS queues

**Labels:** `chore` `area:local-dev` · **Milestone:** M2 · **Depends on:** BE-031

**Acceptance criteria**

- [ ] `user-actions.fifo` with a DLQ (`maxReceiveCount: 3`), visibility timeout 60 s, content-based dedup **off**.
- [ ] `faults` queue (FIFO or standard, matching infra's choice).
- [ ] Queue URLs printed and matching `.env.example`.

### BE-035 · spike: verify LocalStack supports dynamodb:updateItem.waitForTaskToken (O-02)

**Labels:** `spike` `area:local-dev` `area:orchestration` · **Milestone:** M2 · **Depends on:** BE-032, BE-034

**Acceptance criteria**

- [ ] A throwaway state machine in LocalStack that stores a task token on an item and waits; `SendTaskSuccess` resumes it.
- [ ] Result recorded in DECISIONS (close O-02). If unsupported, open a follow-up for a dev orchestrator script.

### BE-036 · chore(local): add local copy of the state machine and create it on init

**Labels:** `chore` `area:local-dev` `area:orchestration` `cross-repo` · **Milestone:** M2 · **Depends on:** BE-035

**Acceptance criteria**

- [ ] `local/statemachine.asl.json` copied from the infra repo, with LocalStack ARNs; a header comment says where the source of truth is.
- [ ] Init script creates it; ARN matches `STATE_MACHINE_ARN` in `.env.example`.

### BE-037 · test: add integration test harness

**Labels:** `test` `area:local-dev` · **Milestone:** M2 · **Depends on:** BE-006, BE-032, BE-033

**Acceptance criteria**

- [ ] `test/helpers/` with: env loader for compose, real clients pointing at LocalStack/Redis, unique id/prefix per test file, cleanup helpers.
- [ ] Integration tests skip with a clear message when LocalStack isn't reachable.
- [ ] One smoke integration test (write and read a DynamoDB item).

### BE-038 · ci: run integration tests against docker-compose

**Labels:** `ci` `test` · **Milestone:** M2 · **Depends on:** BE-037

**Acceptance criteria**

- [ ] CI job starts compose, waits for healthchecks, runs `pnpm test:integration`, tears down.

---

## M2 · OpenAPI

### BE-039 · feat(openapi): add registry and generator script

**Labels:** `feat` `area:platform` · **Milestone:** M2 · **Depends on:** BE-020

**Acceptance criteria**

- [ ] `src/openapi/registry.ts` with `extendZodWithOpenApi` and a shared `OpenAPIRegistry`; Bearer auth security scheme registered.
- [ ] `pnpm openapi` writes `openapi/openapi.json` (stable key order, so diffs are clean).
- [ ] Health routes and the error body schema registered.
- [ ] Generated file committed.

### BE-040 · feat(openapi): serve GET /api/openapi.json

**Labels:** `feat` `area:platform` · **Milestone:** M2 · **Depends on:** BE-039

**Acceptance criteria**

- [ ] Route serves the generated document without auth; supertest test.

### BE-041 · ci: fail CI when openapi.json is stale

**Labels:** `ci` · **Milestone:** M2 · **Depends on:** BE-039, BE-009

**Acceptance criteria**

- [ ] CI runs `pnpm openapi` then `git diff --exit-code openapi/openapi.json`.

---

## M2 · Auth

### BE-042 · feat(auth): verify Cognito access tokens and set req.user

**Labels:** `feat` `area:auth` · **Milestone:** M2 · **Depends on:** BE-020

**Acceptance criteria**

- [ ] Middleware uses `aws-jwt-verify` `CognitoJwtVerifier` (`tokenUse: "access"`, `clientId`, `userPoolId` from config).
- [ ] Sets `req.user = { userId: sub, username }` from the verified token only.
- [ ] Missing, malformed, expired or wrong-client token → 401 `UNAUTHORIZED` (standard error body).
- [ ] Express `Request` type augmented with `user`.
- [ ] The verifier is injectable so tests don't hit the JWKS.

### BE-043 · feat(auth): support dev mode with x-dev-user header

**Labels:** `feat` `area:auth` · **Milestone:** M2 · **Depends on:** BE-042, BE-013

**Acceptance criteria**

- [ ] With `AUTH_MODE=dev`, `x-dev-user: <id>[:<username>]` sets `req.user`; missing header → 401.
- [ ] Logged once at startup at warn level ("dev auth enabled").

### BE-044 · test(auth): unit tests for the auth middleware

**Labels:** `test` `area:auth` · **Milestone:** M2 · **Depends on:** BE-042, BE-043

**Acceptance criteria**

- [ ] Cases: no header, non-Bearer header, verifier rejects, verifier accepts, dev mode with and without header, health routes reachable without a token.

### BE-045 · docs(auth): decide which claim the leaderboard shows (O-04)

**Labels:** `docs` `area:auth` `area:leaderboard` · **Milestone:** M2 · **Depends on:** BE-042

**Acceptance criteria**

- [ ] Check what the access token carries (`username`, and whether `preferred_username`/`nickname` are available without the ID token).
- [ ] Decision recorded in DECISIONS (close O-04, mitigate L-12); BE-042's `username` source updated if needed.

---

## M2 · Scenarios

### BE-046 · feat(scenarios): define the Scenario zod schema

**Labels:** `feat` `area:scenarios` · **Milestone:** M2 · **Depends on:** BE-012

**Acceptance criteria**

- [ ] `scenarios.schemas.ts` with `ScenarioSchema` matching ARCHITECTURE §7.5 (action types and fault types as zod enums).
- [ ] Cross-field refinements: every `baseline` key is in `targets`; every `validFixes[].type` is in `availableActions`; every fix and fault `target` is in `targets`; `SCALE_DEPLOYMENT` fixes have `minReplicas` between 1 and 3.
- [ ] Unit tests for each refinement.

### BE-047 · feat(scenarios): add the orders-down scenario definition

**Labels:** `feat` `area:scenarios` · **Milestone:** M2 · **Depends on:** BE-046

**Acceptance criteria**

- [ ] `scenarios/orders-down.json` as in ARCHITECTURE §7.5.
- [ ] Unit test that parses every `scenarios/*.json` with `ScenarioSchema` and checks that the file name equals `id`.

### BE-048 · feat(scenarios): load scenarios from S3 with an in-memory cache

**Labels:** `feat` `area:scenarios` · **Milestone:** M2 · **Depends on:** BE-046, BE-022

**Acceptance criteria**

- [ ] `scenarios.repo.ts`: `list()` and `get(id)` read `scenarios/` in `FILES_BUCKET`, validate with zod and cache in memory (one load per process, plus a manual `reload()`).
- [ ] An invalid file is logged and skipped, without crashing the process.
- [ ] Integration test against LocalStack.

### BE-049 · feat(scenarios): add public scenario views (no validFixes)

**Labels:** `feat` `area:scenarios` · **Milestone:** M2 · **Depends on:** BE-046

**Acceptance criteria**

- [ ] `ScenarioSummarySchema` (`id`, `title`, `description`, `maxResolveSeconds`) and `ScenarioPublicSchema` (everything except `validFixes`, `faults` and `scoring` internals that give away the answer). Decide which fields and note them in ARCHITECTURE.
- [ ] `toSummary` / `toPublic` pure mappers; unit test asserts `validFixes` never appears.

### BE-050 · feat(scenarios): add GET /api/scenarios and GET /api/scenarios/:scenarioId

**Labels:** `feat` `area:scenarios` · **Milestone:** M2 · **Depends on:** BE-048, BE-049, BE-042, BE-039

**Acceptance criteria**

- [ ] Routes registered in OpenAPI; 404 for an unknown id.
- [ ] Supertest tests with a fake repo.
- [ ] `pnpm openapi` run, ARCHITECTURE §6 updated if anything changed.

### BE-051 · ci: sync scenarios to S3 in the release workflow

**Labels:** `ci` `area:scenarios` · **Milestone:** M2 · **Depends on:** BE-029, BE-047

**Acceptance criteria**

- [ ] Release workflow validates scenarios (the unit test) and then `aws s3 sync scenarios/ s3://$FILES_BUCKET/scenarios/` (manual trigger, same credentials as the image push).

---

## M2 · Sessions

### BE-052 · feat(sessions): define session schemas and the state enum

**Labels:** `feat` `area:sessions` · **Milestone:** M2 · **Depends on:** BE-039

**Acceptance criteria**

- [ ] `SessionStateSchema` (`STARTING | INCIDENT_ACTIVE | RESOLVED | FAILED`), domain `Session` type (camelCase), `SessionViewSchema` per ARCHITECTURE §6, `CreateSessionBodySchema`.
- [ ] Registered in OpenAPI.

### BE-053 · feat(sessions): add pure state transition rules

**Labels:** `feat` `area:sessions` · **Milestone:** M2 · **Depends on:** BE-052

**Acceptance criteria**

- [ ] `canTransition(from, to)` per ARCHITECTURE §4.1: `STARTING→INCIDENT_ACTIVE`, `STARTING→FAILED`, `INCIDENT_ACTIVE→RESOLVED`, `INCIDENT_ACTIVE→FAILED`; terminal states are final.
- [ ] `isTerminal(state)`.
- [ ] Unit tests cover the full matrix.

### BE-054 · feat(sessions): add item mapping (toItem / fromItem)

**Labels:** `feat` `area:sessions` · **Milestone:** M2 · **Depends on:** BE-052

**Acceptance criteria**

- [ ] camelCase domain ↔ snake_case item per ARCHITECTURE §7.1; `fromItem` validates with zod.
- [ ] `task_token` is never exposed in the domain view returned to routes.
- [ ] Round-trip unit tests.

### BE-055 · feat(sessions): repo create with attribute_not_exists

**Labels:** `feat` `area:sessions` · **Milestone:** M2 · **Depends on:** BE-054, BE-022

**Acceptance criteria**

- [ ] `create(session)` does `PutItem` with `attribute_not_exists(session_id)`; condition failure becomes a domain error.
- [ ] `SessionsRepo` interface exported plus an in-memory fake for service tests.

### BE-056 · feat(sessions): repo get by userId and sessionId

**Labels:** `feat` `area:sessions` · **Milestone:** M2 · **Depends on:** BE-055

**Acceptance criteria**

- [ ] `get(userId, sessionId)` → `Session | null` (`GetItem`, never a Scan). Fake supports it too.

### BE-057 · feat(sessions): repo conditional state transition

**Labels:** `feat` `area:sessions` · **Milestone:** M2 · **Depends on:** BE-055, BE-053

**Acceptance criteria**

- [ ] `transition(userId, sessionId, from, to, extra?)` uses `ConditionExpression: #state = :from`, sets `updated_at`, plus optional fields (`ended_at`, `failure_reason`).
- [ ] `ConditionalCheckFailedException` → `SessionStateConflict` domain error (the SDK error name never leaves the repo).

### BE-058 · feat(sessions): repo worker updates (acknowledge, valid fix, counters)

**Labels:** `feat` `area:sessions` · **Milestone:** M2 · **Depends on:** BE-055

**Acceptance criteria**

- [ ] `markAcknowledged(userId, sessionId, at)`: sets `acknowledged_at` only if it doesn't exist (first time only).
- [ ] `markValidFix(userId, sessionId, at)`: sets `valid_fix_applied_at` only if it doesn't exist.
- [ ] `incrementCounters(userId, sessionId, { actions, wrong })` uses atomic `ADD`.
- [ ] All updates also set `updated_at`.

### BE-059 · feat(sessions): repo list by user with cursor pagination

**Labels:** `feat` `area:sessions` · **Milestone:** M2 · **Depends on:** BE-055

**Acceptance criteria**

- [ ] `listByUser(userId, { limit, cursor })` uses `Query` on PK, newest first (`ScanIndexForward: false`; ULIDs sort by time).
- [ ] `LastEvaluatedKey` ↔ base64url cursor; a tampered cursor → 400 `VALIDATION_ERROR`, and a cursor whose `user_id` isn't the caller's is rejected.

### BE-060 · test(sessions): integration tests for the sessions repo

**Labels:** `test` `area:sessions` · **Milestone:** M2 · **Depends on:** BE-056, BE-057, BE-058, BE-059, BE-037

**Acceptance criteria**

- [ ] Against LocalStack: create + duplicate create, get, transition success + conflict, first-time-only acknowledge, ADD counters, pagination over 3 pages.

### BE-061 · feat(orchestration): define the Orchestration interface and a fake

**Labels:** `feat` `area:orchestration` · **Milestone:** M2 · **Depends on:** BE-008

**Acceptance criteria**

- [ ] `Orchestration { start(input), completeTask(token, output), failTask(token, error, cause) }`.
- [ ] zod schemas for the execution input (ARCHITECTURE §8.1) and task output (§8.2).
- [ ] `orchestration.fake.ts` that records calls, for tests.

### BE-062 · feat(orchestration): implement start with Step Functions

**Labels:** `feat` `area:orchestration` · **Milestone:** M2 · **Depends on:** BE-061, BE-022

**Acceptance criteria**

- [ ] `StartExecution` with `name = sessionId` and the validated input; returns `executionArn`.
- [ ] `ExecutionAlreadyExists` is treated as success (rebuild the ARN from the state machine ARN and the name).
- [ ] Unit test with a mocked `SFNClient` (`aws-sdk-client-mock`).

### BE-063 · feat(orchestration): implement completeTask and failTask

**Labels:** `feat` `area:orchestration` · **Milestone:** M2 · **Depends on:** BE-061, BE-022

**Acceptance criteria**

- [ ] `SendTaskSuccess` / `SendTaskFailure`; `TaskTimedOut` and `InvalidToken` are logged at warn and reported as `"already-ended"`, without throwing.
- [ ] The task token is never logged.
- [ ] Unit tests with a mocked client.

### BE-064 · feat(platform): implement the global session lock

**Labels:** `feat` `area:platform` · **Milestone:** M2 · **Depends on:** BE-023, BE-016

**Acceptance criteria**

- [ ] `Lock` interface: `acquire(sessionId, ttlMs) → boolean`, `holder() → string | null`, `remainingMs() → number`, `release(sessionId) → boolean`.
- [ ] Redis implementation: `SET lock:active-session <id> NX PX <ttl>`; release uses a compare-and-delete Lua script (never a plain `DEL`).
- [ ] In-memory fake for unit tests.
- [ ] Integration tests: second acquire fails, release by a non-holder is a no-op, PTTL reported, expiry frees it.

### BE-065 · feat(sessions): compute lock TTL from the scenario

**Labels:** `feat` `area:sessions` · **Milestone:** M2 · **Depends on:** BE-046

**Acceptance criteria**

- [ ] Pure `lockTtlMs(scenario) = (warmupSeconds + maxResolveSeconds + 180) * 1000`; unit test.

### BE-066 · feat(sessions): implement startSession in the service

**Labels:** `feat` `area:sessions` · **Milestone:** M2 · **Depends on:** BE-055, BE-057, BE-061, BE-064, BE-065, BE-071

**Acceptance criteria**

- [ ] `createSessionsService(deps)` with `startSession(user, scenarioId)` following ARCHITECTURE §4.2 step 1: acquire the lock → put `STARTING` (with `username`) → append `SESSION_STARTED` → start the execution (input §8.1 with a new `faultId`) → store `execution_arn`.
- [ ] Lock taken → `conflict("SESSION_BUSY", …, { retryAfterSeconds })` from the lock's remaining time.
- [ ] Unknown scenario → 404 before taking the lock.
- [ ] If put or start fails: mark `FAILED` (best effort), release the lock, rethrow → 500.
- [ ] Unit tests for each branch with fakes and a fixed clock.

### BE-067 · feat(sessions): add POST /api/sessions

**Labels:** `feat` `area:sessions` · **Milestone:** M2 · **Depends on:** BE-066, BE-042

**Acceptance criteria**

- [ ] 201 `{ sessionId }`; 404 unknown scenario; 409 `SESSION_BUSY` with `details.retryAfterSeconds`.
- [ ] Registered in OpenAPI; supertest tests.

### BE-068 · feat(sessions): add GET /api/sessions/:sessionId

**Labels:** `feat` `area:sessions` · **Milestone:** M2 · **Depends on:** BE-056, BE-042

**Acceptance criteria**

- [ ] Reads with `PK = req.user.userId`; missing or someone else's → 404.
- [ ] Returns `SessionView` (no `task_token`, no `execution_arn`).
- [ ] Registered in OpenAPI; supertest tests including the other-user 404.

### BE-069 · feat(sessions): add GET /api/me/sessions

**Labels:** `feat` `area:sessions` · **Milestone:** M2 · **Depends on:** BE-059, BE-042

**Acceptance criteria**

- [ ] `limit` (1–50, default 20) and `cursor` query params validated; returns `{ items, nextCursor? }`.
- [ ] Registered in OpenAPI; supertest tests.

---

## M2 · Events

### BE-070 · feat(events): define the event line schema

**Labels:** `feat` `area:events` `cross-repo` · **Milestone:** M2 · **Depends on:** BE-008

**Acceptance criteria**

- [ ] `EventLineSchema` matching ARCHITECTURE §7.4 exactly: every key always present (null when not applicable), `type` enum.
- [ ] `buildEvent(partial)` fills the missing keys with null.
- [ ] Unit test: every built event has the same key set (keeps the Glue schema flat).

### BE-071 · feat(events): append events to the Redis buffer

**Labels:** `feat` `area:events` · **Milestone:** M2 · **Depends on:** BE-070, BE-023

**Acceptance criteria**

- [ ] `EventLog.append(sessionId, event)` → `RPUSH session:{id}:events` + `EXPIRE 2h`.
- [ ] `EventLog` interface + in-memory fake.

### BE-072 · feat(events): read recent events for the dashboard

**Labels:** `feat` `area:events` · **Milestone:** M3 · **Depends on:** BE-071

**Acceptance criteria**

- [ ] `recent(sessionId, n = 20)` → `LRANGE -n -1`, each line parsed with zod; invalid lines skipped and logged.
- [ ] Pure `summarizeEvent(event) → string` for the dashboard's `summary` field, with unit tests.

### BE-073 · feat(events): flush the buffer to S3 as NDJSON

**Labels:** `feat` `area:events` · **Milestone:** M3 · **Depends on:** BE-071, BE-022

**Acceptance criteria**

- [ ] `flush(session)` writes `logs/year=YYYY/month=MM/day=DD/{sessionId}.ndjson` (date from `created_at`, UTC), one event per line, `ContentType: application/x-ndjson`.
- [ ] Idempotent (re-flushing overwrites the same key); empty buffer → no object written.
- [ ] Redis keys deleted only after a successful upload.
- [ ] Integration test against LocalStack S3.

---

## M2 · mock-cluster gateway

### BE-074 · feat(mock-cluster): define the gateway interface

**Labels:** `feat` `area:mock-cluster` · **Milestone:** M2 · **Depends on:** BE-008

**Acceptance criteria**

- [ ] `MockClusterGateway`: `listDeployments()`, `listPods()`, `readLogs(service, tailLines)`, `scale(deployment, replicas)`, `restart(deployment)`, `checkHealth(service) → { healthy, latencyMs? }`.
- [ ] Plain domain types (no k8s client types in the interface).

### BE-075 · feat(mock-cluster): add an in-memory fake cluster

**Labels:** `feat` `area:mock-cluster` · **Milestone:** M2 · **Depends on:** BE-074

**Acceptance criteria**

- [ ] `mock-cluster.fake.ts` starts from a baseline, supports `scale`/`restart`, reports pods and health (a deployment with 0 ready replicas → unhealthy), returns canned log lines.
- [ ] Exposes `applyFault(fault)` so `dev-inject` and tests can break it.
- [ ] Unit tests.

### BE-076 · feat(mock-cluster): list deployments and pods with the k8s client

**Labels:** `feat` `area:mock-cluster` · **Milestone:** M2 · **Depends on:** BE-074, BE-012

**Acceptance criteria**

- [ ] `KubeConfig.loadFromDefault()`; namespaced calls on `MOCK_NAMESPACE` only.
- [ ] Maps to domain types (desired/ready replicas, pod phase, ready, restarts, age).
- [ ] Only this file imports `@kubernetes/client-node`.

### BE-077 · feat(mock-cluster): read pod logs

**Labels:** `feat` `area:mock-cluster` · **Milestone:** M2 · **Depends on:** BE-076

**Acceptance criteria**

- [ ] Picks the pods for a deployment by label selector, reads the last 100 lines (`tailLines`), merges by pod.
- [ ] No pods (scaled to 0) → empty lines, not an error.

### BE-078 · feat(mock-cluster): scale and rollout-restart deployments

**Labels:** `feat` `area:mock-cluster` · **Milestone:** M2 · **Depends on:** BE-076

**Acceptance criteria**

- [ ] `scale` patches `deployments/scale`; `restart` patches `spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"]`.
- [ ] Both are idempotent and namespaced; replicas are bounds-checked (1–3) before the call.
- [ ] Confirm the RBAC in ARCHITECTURE §8.6 covers both verbs.

### BE-079 · feat(mock-cluster): HTTP health checks with a timeout

**Labels:** `feat` `area:mock-cluster` · **Milestone:** M2 · **Depends on:** BE-074, BE-012

**Acceptance criteria**

- [ ] GET `MOCK_HEALTH_URL_TEMPLATE` with `{service}` replaced; `AbortSignal.timeout(1500)`; non-2xx or timeout → unhealthy; records `latencyMs`.
- [ ] `fetch` injectable; unit tests for 200, 500 and timeout.

### BE-080 · feat(mock-cluster): select the gateway implementation from config

**Labels:** `feat` `area:mock-cluster` · **Milestone:** M2 · **Depends on:** BE-075, BE-076

**Acceptance criteria**

- [ ] `createMockClusterGateway(config)` returns the fake for `MOCK_CLUSTER=fake` and the k8s one otherwise; used by both composition roots.

---

## M2 · Actions (API side)

### BE-081 · feat(actions): define action request and queue message schemas

**Labels:** `feat` `area:actions` `cross-repo` · **Milestone:** M2 · **Depends on:** BE-052

**Acceptance criteria**

- [ ] `ActionRequestSchema` (`type`, `target?`, `params?`); `SCALE_DEPLOYMENT` requires `params.replicas` in 1–3.
- [ ] `QueueMessageSchema` as a discriminated union on `kind`: `USER` (ARCHITECTURE §8.5) and `SYSTEM`/`SESSION_ENDED` (§8.4).
- [ ] `SESSION_ENDED` and `ABANDON` can never be sent through `ActionRequestSchema`.
- [ ] Unit tests: valid and invalid messages of each kind.

### BE-082 · feat(actions): validate an action against the scenario and session state

**Labels:** `feat` `area:actions` · **Milestone:** M2 · **Depends on:** BE-081, BE-046

**Acceptance criteria**

- [ ] Pure `checkActionAllowed(scenario, session, action)` per ARCHITECTURE §5: type in `availableActions`, target in `targets`; session must be `INCIDENT_ACTIVE` (except `ACKNOWLEDGE`, also allowed in `STARTING`).
- [ ] Returns a reason that maps to 422 `ACTION_NOT_ALLOWED` or 409 `SESSION_NOT_ACTIVE`.
- [ ] Unit tests close to 100% branch coverage.

### BE-083 · feat(actions): add pure isValidFix

**Labels:** `feat` `area:actions` · **Milestone:** M2 · **Depends on:** BE-046, BE-081

**Acceptance criteria**

- [ ] Same `type` and `target` as a `validFixes` entry; for scale, `replicas >= minReplicas`.
- [ ] `isPenalized(action)`: false for `ACKNOWLEDGE` and `VIEW_LOGS`.
- [ ] Unit tests close to 100%.

### BE-084 · feat(actions): add the SQS producer for user-actions

**Labels:** `feat` `area:actions` · **Milestone:** M2 · **Depends on:** BE-081, BE-022

**Acceptance criteria**

- [ ] `enqueue(message)` validates with `QueueMessageSchema`, then `SendMessage` with `MessageGroupId = sessionId` and `MessageDeduplicationId = actionId`.
- [ ] `ActionQueue` interface + fake.

### BE-085 · feat(actions): add POST /api/sessions/:sessionId/actions

**Labels:** `feat` `area:actions` · **Milestone:** M2 · **Depends on:** BE-082, BE-084, BE-068

**Acceptance criteria**

- [ ] Loads the session for the caller (404 if not theirs), loads the scenario, checks the action, enqueues with a new ULID `actionId` and `requestedAt`.
- [ ] 202 `{ actionId }`; 409 `SESSION_NOT_ACTIVE`; 422 `ACTION_NOT_ALLOWED`; 400 bad shape.
- [ ] Registered in OpenAPI; supertest tests.

### BE-086 · feat(actions): add GET /api/sessions/:sessionId/logs

**Labels:** `feat` `area:actions` `area:mock-cluster` · **Milestone:** M2 · **Depends on:** BE-077, BE-080, BE-071, BE-068

**Acceptance criteria**

- [ ] `service` query param must be in the scenario's `targets` (422 otherwise) **before** any k8s call.
- [ ] Session must be active (409 otherwise).
- [ ] Returns `{ service, lines }` (last 100) and appends a `VIEW_LOGS` event; not queued (D-15).
- [ ] Registered in OpenAPI; supertest tests with the fake gateway.

### BE-087 · feat(sessions): add POST /api/sessions/:sessionId/abandon

**Labels:** `feat` `area:sessions` · **Milestone:** M2 · **Depends on:** BE-084, BE-068

**Acceptance criteria**

- [ ] Caller must own the session (404); terminal session → 409.
- [ ] Enqueues a `USER` message of type `ABANDON`; returns 202.
- [ ] Registered in OpenAPI; supertest tests.

---

## M2 · Worker: actions consumer

### BE-088 · feat(worker): add the SQS consumer loop

**Labels:** `feat` `area:worker` · **Milestone:** M2 · **Depends on:** BE-081, BE-022, BE-026

**Acceptance criteria**

- [ ] Long polls (`WaitTimeSeconds: 20`, `MaxNumberOfMessages: 10`), stops on `AbortSignal`.
- [ ] Parses each body with `QueueMessageSchema`; invalid → logged at error and **not** deleted (it reaches the DLQ after 3 receives).
- [ ] Dispatches to a handler map by type; deletes only after the handler succeeds.
- [ ] A handler error never kills the loop.
- [ ] Unit tests with a fake queue client.

### BE-089 · feat(worker): add action idempotency

**Labels:** `feat` `area:worker` · **Milestone:** M2 · **Depends on:** BE-088, BE-023

**Acceptance criteria**

- [ ] Before applying, `SET action:{actionId} 1 NX EX 86400`; already set → ack and skip.
- [ ] Decide and document what happens if the handler fails after the key is set (delete the key on failure so the retry runs).
- [ ] Unit test with duplicate delivery.

### BE-090 · feat(worker): handle ACKNOWLEDGE

**Labels:** `feat` `area:worker` · **Milestone:** M2 · **Depends on:** BE-088, BE-058, BE-071

**Acceptance criteria**

- [ ] If the session is `INCIDENT_ACTIVE`: `markAcknowledged` (first time only) and append `ACKNOWLEDGED`.
- [ ] If still `STARTING`: record the event but don't set `acknowledged_at` (doesn't count toward TTD).
- [ ] Counts toward `actions_count`, never toward `wrong_actions`.
- [ ] Unit tests with a fixed clock.

### BE-091 · feat(worker): handle SCALE_DEPLOYMENT and RESTART_DEPLOYMENT

**Labels:** `feat` `area:worker` · **Milestone:** M2 · **Depends on:** BE-088, BE-078, BE-083, BE-058, BE-071

**Acceptance criteria**

- [ ] Re-checks that the session is `INCIDENT_ACTIVE` and the target is in the scenario (skip and ack if not).
- [ ] Applies via the gateway, then: valid fix → `markValidFix`; otherwise `wrong += 1`; always `actions += 1`.
- [ ] Appends an `ACTION` event with `valid`.
- [ ] Unit tests with the fake cluster: valid fix, wrong target, scale below `minReplicas`.

### BE-092 · feat(worker): handle ABANDON

**Labels:** `feat` `area:worker` · **Milestone:** M2 · **Depends on:** BE-088, BE-063

**Acceptance criteria**

- [ ] Loads the session; if it has a `task_token`, calls `failTask(token, "Abandoned", …)`; "already-ended" is fine.
- [ ] If there's no token yet (still `STARTING`), decide and document the behavior (for example, stop the execution or wait). Record it in DECISIONS.
- [ ] Unit tests.

### BE-093 · feat(worker): graceful shutdown of the consumer

**Labels:** `feat` `area:worker` · **Milestone:** M2 · **Depends on:** BE-088

**Acceptance criteria**

- [ ] On `SIGTERM`: stop receiving, wait for in-flight handlers up to 25 s, close Redis, exit 0.
- [ ] Unit test with an abort during a slow handler.

### BE-094 · test(worker): consumer integration test against LocalStack SQS

**Labels:** `test` `area:worker` · **Milestone:** M2 · **Depends on:** BE-088, BE-089, BE-091, BE-037

**Acceptance criteria**

- [ ] Sends a valid action and a duplicate; asserts one application on the fake cluster and both messages deleted.
- [ ] Sends a poison message; asserts it isn't deleted.

---

## M3 · Dashboard, scoring and resolution

### BE-095 · feat(dashboard): define the DashboardSnapshot schema

**Labels:** `feat` `area:dashboard` · **Milestone:** M3 · **Depends on:** BE-052

**Acceptance criteria**

- [ ] `DashboardSnapshotSchema` per ARCHITECTURE §6, plus optional `stale: boolean`.
- [ ] Registered in OpenAPI.

### BE-096 · feat(dashboard): add the pure snapshot builder

**Labels:** `feat` `area:dashboard` · **Milestone:** M3 · **Depends on:** BE-095, BE-074, BE-072

**Acceptance criteria**

- [ ] `buildSnapshot({ session, scenario, deployments, pods, health, events, now })` → `DashboardSnapshot`.
- [ ] Health rule: `down` (0 ready or failed check), `degraded` (ready < desired or slow), `healthy`. Document the thresholds.
- [ ] Only services in `scenario.targets`; `elapsedSeconds` from `fault_injected_at` (or `created_at` before the fault).
- [ ] Unit tests.

### BE-097 · feat(dashboard): store and read snapshots in Redis

**Labels:** `feat` `area:dashboard` · **Milestone:** M3 · **Depends on:** BE-095, BE-023

**Acceptance criteria**

- [ ] `SnapshotStore.put(snapshot)` → `SET dashboard:{id} … EX 10`; `get(id)` validates with zod (a bad shape → treated as missing).
- [ ] Interface + fake.

### BE-098 · feat(scoring): compute TTD, TTR and score

**Labels:** `feat` `area:scoring` · **Milestone:** M3 · **Depends on:** BE-046

**Acceptance criteria**

- [ ] Pure functions in `scoring/`: `ttdSeconds`, `ttrSeconds` (integer seconds from `fault_injected_at`), `score = max(0, base − perSecondTTD·TTD − perSecondTTR·TTR − perWrongAction·wrong)`.
- [ ] Never acknowledged → TTD = TTR.
- [ ] Unit tests close to 100%: zero floor, rounding, missing acknowledge, the example in ARCHITECTURE §8.2.

### BE-099 · feat(dashboard): add the consecutive-healthy resolution detector

**Labels:** `feat` `area:dashboard` · **Milestone:** M3 · **Depends on:** BE-023

**Acceptance criteria**

- [ ] Pure `isResolved({ state, validFixAppliedAt, allHealthy, consecutiveHealthy })`: `INCIDENT_ACTIVE` + valid fix applied + healthy on 2 consecutive checks (D-07).
- [ ] Counter stored in `session:{id}:health` (`INCR` on healthy, reset on unhealthy, `EX 3600`).
- [ ] Unit tests for flapping (healthy, unhealthy, healthy → not resolved).

### BE-100 · feat(worker): add the monitor loop that writes snapshots

**Labels:** `feat` `area:worker` `area:dashboard` · **Milestone:** M3 · **Depends on:** BE-096, BE-097, BE-064, BE-080

**Acceptance criteria**

- [ ] Every 2 s with an `AbortSignal`; reads the lock holder; **no lock → no k8s calls**.
- [ ] Needs `userId` to read the session. Decide how the worker gets it from the lock (for example, store `sessionId` and also `session:{id}:owner`, or put `userId:sessionId` in the lock value). Record it in ARCHITECTURE §7.2.
- [ ] Builds and stores the snapshot; one failing tick is logged and the loop continues.
- [ ] Unit tests with a fake clock and fakes.

### BE-101 · feat(worker): complete the task when the incident is resolved

**Labels:** `feat` `area:worker` `area:scoring` · **Milestone:** M3 · **Depends on:** BE-100, BE-099, BE-098, BE-063

**Acceptance criteria**

- [ ] On resolution: compute TTD/TTR/score, append `RESOLVED` and `SCORED` events, call `completeTask(token, output §8.2)`.
- [ ] Runs once per session (guard with a Redis flag or the session state) even if the next tick still sees it healthy.
- [ ] "already-ended" from the orchestration is logged, not retried.
- [ ] Unit tests.

### BE-102 · feat(worker): handle SESSION_ENDED cleanup

**Labels:** `feat` `area:worker` `cross-repo` · **Milestone:** M3 · **Depends on:** BE-088, BE-073, BE-078, BE-064

**Acceptance criteria**

- [ ] Per ARCHITECTURE §4.2 step 7: flush events → reset the mock system to `baseline` → wait until healthy (max 60 s; warn if not) → release the lock **only if it holds this sessionId** → delete `dashboard:{id}` and `session:{id}:health`.
- [ ] Each step runs even if an earlier one fails (except the lock release, which is always attempted last); failures logged with `sessionId`.
- [ ] Idempotent on redelivery.
- [ ] Unit tests with fakes.

### BE-103 · feat(dashboard): add GET /api/sessions/:sessionId/dashboard

**Labels:** `feat` `area:dashboard` · **Milestone:** M3 · **Depends on:** BE-097, BE-068

**Acceptance criteria**

- [ ] Ownership checked first (404).
- [ ] Returns the Redis snapshot; if it's missing or older than 10 s, returns the last known one with `stale: true`, or a minimal snapshot built from the DynamoDB item (empty `services`).
- [ ] Terminal sessions return a minimal final snapshot.
- [ ] Registered in OpenAPI; supertest tests for fresh, stale and missing.

### BE-104 · docs: confirm cross-repo proposals D-11, D-12 and D-13 with infra (O-01)

**Labels:** `docs` `cross-repo` · **Milestone:** M2 · **Depends on:** —

**Acceptance criteria**

- [ ] Ian confirms: `SESSION_ENDED` on every terminal path (D-11), the injector updates the session and appends `FAULT_INJECTED` (D-12), FIFO `user-actions` (D-13), and the RBAC in §8.6.
- [ ] Statuses in DECISIONS changed from Proposed to Decided (or adjusted), O-01 closed.

---

## M2/M3 · Dev tooling

### BE-105 · chore(scripts): add dev-inject to stand in for the injector

**Labels:** `chore` `area:local-dev` · **Milestone:** M3 · **Depends on:** BE-075, BE-057, BE-071, BE-036

**Acceptance criteria**

- [ ] `scripts/dev-inject.ts` long-polls the LocalStack `faults` queue and, per message: applies the fault to the fake cluster, does the conditional update `STARTING → INCIDENT_ACTIVE` with `fault_injected_at`, appends `FAULT_INJECTED` (same as ARCHITECTURE §8.3).
- [ ] `pnpm dev:inject` script.
- [ ] Needs the fake cluster to be shared with the worker. Decide how (run inside the worker process when `MOCK_CLUSTER=fake`, or store fake state in Redis) and document it.

### BE-106 · chore(scripts): add a seed script with demo sessions

**Labels:** `chore` `area:local-dev` · **Milestone:** M4 · **Depends on:** BE-055, BE-073

So the frontend can build history, stats and leaderboard screens without playing full sessions.

**Acceptance criteria**

- [ ] `pnpm seed` writes a few `RESOLVED`/`FAILED` sessions for 2–3 dev users into LocalStack, plus matching NDJSON logs.
- [ ] Only runs against LocalStack (refuses when `AWS_ENDPOINT_URL` is unset).

---

## M4 · Stats (Athena)

### BE-107 · docs(stats): agree on the Glue table and partitions with infra

**Labels:** `docs` `area:stats` `cross-repo` · **Milestone:** M4 · **Depends on:** BE-070

**Acceptance criteria**

- [ ] Glue table columns match the event line (ARCHITECTURE §7.4); partitions `year/month/day` with partition projection (no crawler needed).
- [ ] Workgroup and database names confirmed for `ATHENA_WORKGROUP` / `ATHENA_DATABASE`.

### BE-108 · feat(stats): add the Athena query runner

**Labels:** `feat` `area:stats` · **Milestone:** M4 · **Depends on:** BE-022, BE-016

**Acceptance criteria**

- [ ] Loads SQL only from `src/modules/stats/queries/*.sql` (copied into `dist` at build time).
- [ ] `StartQueryExecution` with `ExecutionParameters` (positional `?`), polls `GetQueryExecution` with backoff for up to 20 s, then `gatewayTimeout("STATS_TIMEOUT")`.
- [ ] Maps `GetQueryResults` rows to objects (header row → keys, typed by column type).
- [ ] Unit tests with a mocked Athena client and a fixed clock.

### BE-109 · feat(stats): add the score-over-time query

**Labels:** `feat` `area:stats` · **Milestone:** M4 · **Depends on:** BE-108, BE-107

**Acceptance criteria**

- [ ] `queries/score-over-time.sql`: `SCORED` events for the user, ordered by time; filtered by `user_id = ?` and a partition range.
- [ ] zod row schema; registered response schema in OpenAPI.

### BE-110 · feat(stats): add the ttd-ttr-by-attempt query

**Labels:** `feat` `area:stats` · **Milestone:** M4 · **Depends on:** BE-108, BE-107

**Acceptance criteria**

- [ ] `queries/ttd-ttr-by-attempt.sql`: TTD and TTR per session for the user, numbered by attempt; filtered by `user_id = ?` and partition.
- [ ] zod row schema; registered in OpenAPI.

### BE-111 · feat(stats): add fixture mode

**Labels:** `feat` `area:stats` `area:local-dev` · **Milestone:** M4 · **Depends on:** BE-109, BE-110

**Acceptance criteria**

- [ ] `STATS_MODE=fixture` returns static rows from `test/fixtures/stats/*.json` that pass the row schemas (LocalStack Athena is paid, D-18).

### BE-112 · feat(stats): cache results in Redis

**Labels:** `feat` `area:stats` · **Milestone:** M4 · **Depends on:** BE-108, BE-023

**Acceptance criteria**

- [ ] `stats:{userId}:{query}` with a 5-minute TTL; cache hit skips Athena.
- [ ] On Athena timeout, a cached value (even expired, if kept in a longer-lived `:last` key) is served; otherwise 504. Document the choice in ARCHITECTURE §7.2.
- [ ] Unit tests.

### BE-113 · feat(stats): add GET /api/me/stats/:queryName

**Labels:** `feat` `area:stats` · **Milestone:** M4 · **Depends on:** BE-111, BE-112, BE-042

**Acceptance criteria**

- [ ] `queryName ∈ score-over-time | ttd-ttr-by-attempt`, else 404; always scoped to `req.user.userId`.
- [ ] 200 `{ rows }`; 504 `STATS_TIMEOUT`.
- [ ] Registered in OpenAPI; supertest tests.

---

## M4 · Leaderboard

### BE-114 · feat(leaderboard): query the Leaderboard GSI

**Labels:** `feat` `area:leaderboard` · **Milestone:** M4 · **Depends on:** BE-054, BE-022

**Acceptance criteria**

- [ ] `topScores(scenarioId, limit)` queries GSI `Leaderboard` with `ScanIndexForward: false`; projects only `username`, `score`, `ttr_seconds`, `session_id`, `ended_at`.
- [ ] Integration test against LocalStack.

### BE-115 · feat(leaderboard): rank entries and cache them

**Labels:** `feat` `area:leaderboard` · **Milestone:** M4 · **Depends on:** BE-114, BE-023

**Acceptance criteria**

- [ ] Pure ranking: ties on score broken by lower `ttrSeconds`, then earlier `endedAt`; `rank` starts at 1.
- [ ] `leaderboard:{scenarioId}` cached 60 s.
- [ ] Unit tests for the tie-breaks.

### BE-116 · feat(leaderboard): add GET /api/leaderboard/:scenarioId

**Labels:** `feat` `area:leaderboard` · **Milestone:** M4 · **Depends on:** BE-115, BE-048

**Acceptance criteria**

- [ ] `limit` 1–50, default 10; unknown scenario → 404.
- [ ] Response contains only `LeaderboardEntry` fields (no `userId`).
- [ ] Registered in OpenAPI; supertest tests.

---

## M5 · Finish

### BE-117 · test: ownership matrix across every session route

**Labels:** `test` `area:sessions` · **Milestone:** M5 · **Depends on:** BE-068, BE-085, BE-086, BE-087, BE-103

**Acceptance criteria**

- [ ] User B gets **404** for user A's session, dashboard, actions, logs and abandon (ARCHITECTURE §3.1).
- [ ] `/api/me/*` returns only the caller's data.

### BE-118 · test: e2e happy path against docker-compose

**Labels:** `test` · **Milestone:** M5 · **Depends on:** BE-101, BE-102, BE-105, BE-038

**Acceptance criteria**

- [ ] With `MOCK_CLUSTER=fake`, `AUTH_MODE=dev`: start a session → fault injected → acknowledge → scale `orders` to 2 → session `RESOLVED` with a score → NDJSON object in S3 → lock released → a second session can start.
- [ ] Runs in CI (the integration job).

### BE-119 · test: failure paths (busy lock, abandon, timeout)

**Labels:** `test` · **Milestone:** M5 · **Depends on:** BE-118

**Acceptance criteria**

- [ ] Second start while active → 409 with `retryAfterSeconds`.
- [ ] Abandon → `FAILED`, cleanup runs, lock released.
- [ ] Short `maxResolveSeconds` → timeout → `FAILED`, cleanup runs.

### BE-120 · test: logs never contain tokens or credentials

**Labels:** `test` `area:platform` · **Milestone:** M5 · **Depends on:** BE-014, BE-063

**Acceptance criteria**

- [ ] Captures logger output in a request with a Bearer token and in `completeTask`; asserts neither the JWT nor the task token appears.

### BE-121 · chore: review error codes and status codes against CONVENTIONS §4

**Labels:** `chore` · **Milestone:** M5 · **Depends on:** BE-116

**Acceptance criteria**

- [ ] One `ErrorCode` `as const` list; every thrown code is in it and in the OpenAPI error schema enum.
- [ ] Every route's documented error statuses match what it actually returns.

### BE-122 · ci: add pnpm audit (warn only) and Dependabot

**Labels:** `ci` · **Milestone:** M5 · **Depends on:** BE-009

**Acceptance criteria**

- [ ] CI step `pnpm audit --prod` that reports without failing.
- [ ] `.github/dependabot.yml` for npm and GitHub Actions, weekly, grouped minor updates.

### BE-123 · docs: finalize ARCHITECTURE, DECISIONS and remove (planned) markers

**Labels:** `docs` · **Milestone:** M5 · **Depends on:** BE-118

**Acceptance criteria**

- [ ] Every route, key, message and env var in ARCHITECTURE matches the code; `(planned)` only where still true (for example `ROLLBACK`).
- [ ] New decisions made along the way have D-xx entries; open questions closed or moved.

### BE-124 · docs: write the local run guide in README

**Labels:** `docs` `area:local-dev` · **Milestone:** M5 · **Depends on:** BE-105, BE-118

**Acceptance criteria**

- [ ] Step by step for run mode 1 (ARCHITECTURE §10): compose up, env, api, worker, dev-inject, sample `curl` with `x-dev-user`.
- [ ] Short notes on mode 2 (kind) and mode 3 (EKS, link to infra).
- [ ] Troubleshooting section (LocalStack not ready, lock stuck → how to clear it locally).

### BE-125 · docs: write the demo runbook

**Labels:** `docs` · **Milestone:** M5 · **Depends on:** BE-118

**Acceptance criteria**

- [ ] Checklist before the Nov 26 demo: refresh lab credentials, image tag deployed, scenarios synced, `/readyz` green, lock empty, mock system at baseline.
- [ ] What to do if a session gets stuck (inspect the lock, the Step Functions execution, the DLQ).

### BE-126 · chore: final handoff of the API contract to the frontend

**Labels:** `chore` `cross-repo` · **Milestone:** M5 · **Depends on:** BE-121

**Acceptance criteria**

- [ ] `openapi.json` reviewed with the frontend; every breaking change since the first spec listed in the PR.
- [ ] Polling contract confirmed (2 s, `stale` flag, `retryAfterSeconds` countdown).
