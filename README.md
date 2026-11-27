# On-Call Training · Backend

**On-Call Training** is a web app where students and junior SDE/SREs practice handling a production incident. A small distributed system runs in Kubernetes (EKS) and a real fault is injected into it. The user diagnoses it from a live dashboard and fixes it with predefined actions. The system detects the recovery, scores the attempt (time to detect, time to resolve, wrong actions) and keeps the user's history, charts and a per-scenario leaderboard.

This repo is the **backend**: the HTTP **API** and the **worker** that applies actions, watches the mock system and detects resolution. It also owns the **scenario definitions** and the **OpenAPI spec** the frontend is generated from.

| Repo                                                                              | Contains                                                               |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [oncall-training-infra](https://github.com/Pardosito/oncall-training-infra)       | Terraform, Kubernetes manifests, Step Functions, injector, mock system |
| **oncall-training-backend** (this one)                                            | API + worker, scenarios, `openapi.json`                                |
| [oncall-training-frontend](https://github.com/Pardosito/oncall-training-frontend) | React SPA                                                              |

ITESO _Desarrollo en la Nube_ course project, Fall 2026, team **Cafeinomanos**: Ian Rodríguez and Juan Pablo González.

## How it works

One image runs as two processes:

| Process                            | Replicas | Does                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **api** (`node dist/api.js`)       | 2        | Stateless HTTP. Reads the Cognito user from the JWT, takes the global session lock in Redis, writes sessions to DynamoDB, starts the Step Functions execution, queues user actions to SQS, and serves dashboard snapshots, logs, history, stats and the leaderboard                                                                                  |
| **worker** (`node dist/worker.js`) | 1        | Consumes `user-actions.fifo` and applies actions to the mock system through the Kubernetes API. Every 2 s it rebuilds the dashboard snapshot in Redis and checks for recovery; on recovery it completes the state machine's task token. When a session ends it flushes the event log to S3, resets the mock system to baseline and releases the lock |

A session goes `STARTING → INCIDENT_ACTIVE → RESOLVED | FAILED` (`TIMEOUT`, `ABANDONED` or `ERROR`). Step Functions, defined in the infra repo, drives the timing: it injects the fault, waits for the worker's signal or the time limit, and stores the result.

### API

| Route                                                      | Does                                                                              |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `GET /healthz`, `GET /readyz`                              | Liveness; readiness (DynamoDB, Redis and S3 reachable)                            |
| `GET /api/scenarios`, `GET /api/scenarios/:id`             | Scenario catalog (the valid fixes are never exposed)                              |
| `POST /api/sessions`                                       | Start a session (409 `SESSION_BUSY` with a retry time while another one runs)     |
| `GET /api/sessions/:id`, `GET /api/sessions/:id/dashboard` | Session state; live snapshot (services, pods, latency, events, available actions) |
| `POST /api/sessions/:id/actions`                           | `ACKNOWLEDGE`, `SCALE_DEPLOYMENT`, `RESTART_DEPLOYMENT` (queued, 202)             |
| `GET /api/sessions/:id/logs?service=`                      | Last log lines of a mock service (only if the scenario allows `VIEW_LOGS`)        |
| `POST /api/sessions/:id/abandon`                           | Give up; the session ends `FAILED / ABANDONED`                                    |
| `GET /api/me/sessions`, `GET /api/me/stats/:query`         | History (paginated); chart rows (`score-over-time`, `ttd-ttr-by-attempt`)         |
| `GET /api/leaderboard/:scenarioId`                         | Top scores for a scenario                                                         |
| `GET /api/openapi.json`                                    | The OpenAPI document                                                              |

Full contract: [`openapi/openapi.json`](openapi/openapi.json) and [docs/ARCHITECTURE.md §6](docs/ARCHITECTURE.md#6-http-api).

### Scenarios

Scenarios are JSON files in [`scenarios/`](scenarios), validated in CI and uploaded to S3 on release. Each one defines the warmup, time limit, the fault, the baseline replicas, the allowed actions and targets, the valid fixes and the scoring weights.

| Scenario           | Fault                    | Notes                                                                         |
| ------------------ | ------------------------ | ----------------------------------------------------------------------------- |
| `orders-down`      | `orders` scaled to 0     | Introductory                                                                  |
| `checkout-failing` | `worker-svc` scaled to 0 | Every service looks unhealthy; fixing `orders` first counts as a wrong move   |
| `storefront-down`  | `gateway` scaled to 0    | Short warm-up                                                                 |
| `peak-outage`      | `worker-svc` scaled to 0 | Hard mode: no logs, 3 minutes, double time penalty, 100 points per wrong move |

Score = `base − TTD × perSecondTTD − TTR × perSecondTTR − wrongActions × perWrongAction` (never below 0), with the weights set per scenario.

## Tech stack

- **TypeScript** on **Node 22**, **Express 5**, **Zod** (config, requests and scenarios; the OpenAPI document is generated from the same schemas with zod-to-openapi), **pino** logs
- **AWS SDK v3**: DynamoDB (`Sessions` + `Leaderboard` GSI), SQS, Step Functions, S3
- **ioredis** against ElastiCache (Valkey, TLS): lock, dashboard snapshots, event buffer
- **@kubernetes/client-node** for the mock system (read pods and logs, scale, restart)
- **aws-jwt-verify** for Cognito access tokens
- **Vitest** + Supertest for unit tests; **LocalStack** + Redis through Docker Compose for integration tests
- **Docker** image built for `linux/amd64`, pushed to ECR by the Release workflow

## Running it

Prerequisites: Node 22, pnpm (`corepack enable`), and Docker for the LocalStack setup and image builds.

```bash
pnpm install

# Whole loop in memory, no Docker: api + worker + a fake injector and mock system
pnpm dev:memory                # API on :3000; authenticate with the header `x-dev-user: <id>[:<name>]`

# Same loop on LocalStack (DynamoDB, S3, SQS and Step Functions, seeded by local/init)
cp .env.example .env
docker compose up -d --wait
pnpm dev:local

# Separate processes, e.g. with MOCK_CLUSTER=kubernetes against the infra repo's kind cluster
pnpm dev                       # API on :3000
pnpm dev:worker                # worker, health on :3001
```

The frontend runs against any of these (`pnpm dev` in the frontend repo). For the full AWS deployment (EKS, API Gateway, Cognito), follow the infra repo's [README](https://github.com/Pardosito/oncall-training-infra#running-it).

### Checks

```bash
pnpm test                      # unit tests (no Docker)
pnpm test:integration          # against LocalStack + Redis (docker compose up first)
pnpm lint && pnpm typecheck && pnpm format:check
pnpm openapi                   # regenerate openapi/openapi.json (commit it; CI fails if it's stale)
pnpm build                     # compile to dist/
```

### Docker image and release

```bash
docker buildx build --platform linux/amd64 -t oncall-backend:local --load .
docker run --rm --read-only -p 3000:3000 --env-file .env oncall-backend:local   # worker: append `node dist/worker.js`
```

Always build for `linux/amd64`: the EKS nodes are x86_64, and an ARM image crashes there with `exec format error`.

Only the **Release** workflow (Actions → Release → Run workflow) pushes to ECR:

1. Refresh the Learner Lab credentials first. The repo's `AWS_*` secrets expire with each lab session; the infra repo's `make creds` updates them in all three repos.
2. The workflow validates `scenarios/*.json` and syncs them to `s3://oncall-training-files-<account>/scenarios/`. The API caches scenarios per pod, so restart the API pods after a scenario change.
3. It pushes `oncall-training/backend:<short git sha>` (immutable tags, never `latest`).
4. Roll it out from the infra repo with `make deploy BACKEND_TAG=<sha>`.

What the infra manifests need (ports, probes, env vars, replicas, RBAC) is in [docs/ARCHITECTURE.md §12](docs/ARCHITECTURE.md#12-deployment-contract-for-the-infra-repos-manifests).

## Limitations

- **One session at a time.** All users share one mock system, so a Redis lock admits a single active incident. Other users get a 409 with a retry time (up to about 13 minutes in the worst case). If Redis restarts mid-session, the lock and that session's event buffer are lost.
- **One fault per scenario.** Only the first entry of a scenario's `faults` is injected.
- **Single worker.** The monitor loop isn't safe to run twice, so a worker restart pauses sessions for a few seconds. Actions are delayed, not lost.
- **Polling, not push.** The dashboard is about 2 s behind reality.
- **Shared IAM role.** Every pod uses the Learner Lab's `LabRole`; there are no per-service permissions.
- **Stats come from DynamoDB.** The lab can't run Glue or Athena, so charts are computed from each user's newest 500 sessions.
- **Simple scoring and health model.** Scoring is linear (speed and wrong moves only), and "healthy" means a mock service's `/health` answers 2xx.
- **The mock-system reset can fail.** If it does, the next session starts on a broken system.

**Future work:** one mock namespace per session for real concurrency; Server-Sent Events for the dashboard; per-service IAM roles (IRSA); a durable event stream (Firehose to Parquet) queried with Athena; OpenTelemetry tracing; leader election so the worker can scale; richer faults, scoring and post-mortems. Details in [docs/DECISIONS.md](docs/DECISIONS.md).

## Repository layout

```
src/
  api.ts · worker.ts        process entry points
  app.ts                    Express app (routes, middleware)
  modules/                  auth, scenarios, sessions, actions, dashboard, mock-cluster,
                            orchestration, events, scoring, stats, leaderboard
  platform/                 AWS clients, Redis, Kubernetes, logger, errors, lock, HTTP helpers
  openapi/                  OpenAPI registry and generator
  dev/ · dev-local.ts       local loop (in memory or LocalStack), fake injector
scenarios/                  scenario definitions (JSON)
openapi/openapi.json        generated API spec (committed)
local/                      LocalStack init scripts and the local state machine
test/                       integration tests, fixtures, helpers
```

## Documentation

| Read                                         | For                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [AGENTS.md](AGENTS.md)                       | Scope, stack, architecture summary, rules for contributors                                  |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Processes, modules, session lifecycle, API, data model, cross-repo contracts, configuration |
| [docs/CONVENTIONS.md](docs/CONVENTIONS.md)   | Code style, errors, typing, testing                                                         |
| [docs/DECISIONS.md](docs/DECISIONS.md)       | Decisions and why, limitations, future improvements                                         |
| [docs/BACKLOG.md](docs/BACKLOG.md)           | Issues by milestone                                                                         |
