# On-Call Training — Backend · Agent Context

> Read this first. It explains what this repo is, what it is not, and the rules for working in it.
> Deeper docs:
>
> - `docs/ARCHITECTURE.md`: processes, modules, HTTP API, data shapes, and the contracts with other repos
> - `docs/CONVENTIONS.md`: how code is written here
> - `docs/DECISIONS.md`: what we decided, why, current limitations and future improvements
>
> If you change a contract (route, message, item shape, env var), update `docs/ARCHITECTURE.md` in the same change. If you make a decision, add it to `docs/DECISIONS.md`.

## 1. The project in one paragraph

**On-Call Training** is a web app where students and junior SDE/SREs practice handling a production incident. A user starts a **scenario**. A real (mock) distributed system runs in Kubernetes (EKS), and a fault is injected into it (for example a deployment scaled to 0). The user watches a live dashboard, diagnoses the problem, and fixes it from a **panel of predefined actions** (no terminal). The system detects recovery, computes a score (time to detect, time to resolve, wrong actions) and stores it. Users then see their performance over time in charts built from Athena queries.

ITESO course project, team **Cafeinomanos**: Ian Rodríguez (infra and orchestration) and Juan Pablo González (application and data, **owner of this repo**). It is also meant to be a CV-quality project.

## 2. What this repo is (and isn't)

The system is split into three repos:

| Repo                                     | Contains                                                                                                                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`oncall-training-backend`** (this one) | The **API** (Express HTTP server) and the **worker** (consumes user actions, monitors the mock system, detects resolution). Scenario definitions. The OpenAPI spec. A Dockerfile and docker-compose for local dev. |
| `oncall-training-frontend`               | React SPA. Generates its API types from this repo's `openapi/openapi.json`.                                                                                                                                        |
| `oncall-training-infra`                  | Terraform (all AWS resources), Kubernetes manifests (including this repo's Deployments, ServiceAccounts and RBAC), the Step Functions definition, the **injector** and the **mock system**.                        |

**Not in this repo:** Terraform, k8s manifests, the state machine definition, the injector, the mock services, and frontend code. If a task needs a change there, describe the change needed (contract plus reason) and stop. Don't create those files here.

## 3. MVP scope

In scope:

- **Per-user identity and data separation.** Users sign up and sign in with Cognito. Every session, score, history entry, stat and event belongs to one user (`user_id` = Cognito `sub`). A user can only see their own sessions, history and stats. The leaderboard is the only shared view (username + score).
- **One** scenario end to end.
- One session running at a time across the whole system (global lock).
- Session state and score in DynamoDB.
- Live dashboard through polling.
- Performance stats from ≥2 Athena queries.
- A leaderboard for the scenario.

Out of scope unless the team asks: **editable profiles** (no profile page, avatar, bio or settings), a users table of our own, multiple concurrent sessions, a scenario editor, WebSockets/SSE, admin panels or roles, adaptive scoring, a real terminal.

## 4. Stack

| Concern                  | Choice                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Runtime                  | Node.js 22 LTS                                                                                                          |
| Language                 | TypeScript, `strict`, **ESM** (`"type": "module"`, `module: NodeNext`)                                                  |
| Package manager          | **pnpm**                                                                                                                |
| HTTP                     | **Express 5**                                                                                                           |
| Validation and contracts | **zod**, plus `@asteasolutions/zod-to-openapi` to generate `openapi/openapi.json`                                       |
| Auth                     | Amazon Cognito access tokens verified with `aws-jwt-verify`                                                             |
| AWS                      | AWS SDK for JavaScript v3: `client-dynamodb` + `lib-dynamodb`, `client-sqs`, `client-sfn`, `client-s3`, `client-athena` |
| Cache / lock             | Redis (ElastiCache Valkey/Redis in AWS) via `ioredis`                                                                   |
| Kubernetes               | `@kubernetes/client-node` (reads and fixes the mock system)                                                             |
| Logging                  | `pino` + `pino-http` (JSON)                                                                                             |
| IDs                      | ULID (`ulid`)                                                                                                           |
| Tests                    | **Vitest** + `supertest`; integration tests against docker-compose                                                      |
| Lint / format            | ESLint (typescript-eslint) + Prettier                                                                                   |
| Dev / build              | `tsx watch` for dev, `tsc` for build                                                                                    |
| Container                | Multi-stage Dockerfile, `node:22-alpine`, non-root                                                                      |
| Local AWS                | **LocalStack** (DynamoDB, S3, SQS, Step Functions) + Redis in docker-compose                                            |
| CI                       | GitHub Actions                                                                                                          |

## 5. Commands

```bash
pnpm install
docker compose up -d           # LocalStack + Redis, seeded by local/init/*
pnpm dev                       # API on :3000 (tsx watch)
pnpm dev:worker                # worker (tsx watch), health on :3001
pnpm test                      # unit tests (no Docker needed)
pnpm test:integration          # integration tests (needs docker compose up)
pnpm lint && pnpm typecheck
pnpm openapi                   # regenerate openapi/openapi.json
pnpm build                     # tsc → dist/
```

## 6. Repository layout

```
oncall-training-backend/
├── AGENTS.md · CLAUDE.md · README.md
├── docs/                    ARCHITECTURE.md · CONVENTIONS.md · DECISIONS.md
├── src/
│   ├── api.ts               entrypoint: starts the HTTP server
│   ├── worker.ts            entrypoint: actions consumer + mock-system monitor
│   ├── app.ts               builds the Express app (used by api.ts and tests)
│   ├── config/              env schema (zod), loaded once
│   ├── platform/            shared infrastructure: aws clients, redis, k8s, logger, errors, http middleware, lock
│   ├── modules/             one folder per feature (see CONVENTIONS §3)
│   │   ├── auth/  scenarios/  sessions/  actions/  dashboard/
│   │   ├── mock-cluster/    Kubernetes + health-check gateway to the mock system
│   │   ├── orchestration/   Step Functions start / task success / failure
│   │   ├── events/          session event log (Redis buffer → S3 NDJSON)
│   │   ├── scoring/  stats/  leaderboard/
│   └── openapi/             registry + generator script
├── scenarios/               scenario JSON definitions (synced to S3 scenarios/)
├── openapi/openapi.json     GENERATED, committed; the frontend consumes it
├── test/                    integration tests, fixtures, helpers
├── local/                   docker-compose init scripts, local state machine copy
├── scripts/                 dev utilities (e.g. dev-inject.ts)
├── docker-compose.yml · Dockerfile · .dockerignore · .env.example
└── .github/workflows/       ci.yml (lint, typecheck, test, openapi drift, docker build), release.yml (push to ECR)
```

## 7. Rules for agents

1. **Stay in scope** (§3) and **in this repo** (§2). If something needs a new service, a new AWS resource, or a change in another repo, stop and say what's needed.
2. **Never run commands that create, change or delete AWS resources** (no `aws … create/put/delete`, no pushing images) without explicit confirmation. LocalStack and docker-compose are fine.
3. **No credentials in code or config.** The AWS SDK default credential chain is used everywhere (in EKS that's the node's `LabRole`; locally it's `~/.aws` or LocalStack dummy keys). Never pass `credentials` to a client. Secrets never go in the repo; `.env` is gitignored and `.env.example` is committed.
4. **Contracts first.** Every request, response, SQS message, DynamoDB item and scenario has a zod schema. Change the schema, run `pnpm openapi`, update `docs/ARCHITECTURE.md`. CI fails if `openapi.json` is stale.
5. **Business logic never imports the AWS SDK, ioredis or the k8s client directly.** It goes through repos and gateways in its module or in `platform/` (see CONVENTIONS §3), so it can be unit-tested.
6. **Tests are part of the change.** New logic in `scoring`, fix validation, state transitions, message parsing or the lock needs unit tests in the same PR.
7. **No CORS middleware.** The SPA and API share an origin through CloudFront (`/api/*`). Adding `cors()` hides a routing bug.
8. **Learner Lab constraints apply** (AWS Academy, `LabRole` only, us-east-1, credentials rotate per session). Don't design anything that needs creating IAM roles. See `docs/DECISIONS.md`.
9. Follow `docs/CONVENTIONS.md`. Prefer small PRs, one concern each.

## 8. Timeline (course)

| Date       | Deliverable relevant to this repo                                            |
| ---------- | ---------------------------------------------------------------------------- |
| Thu Oct 29 | API + worker running in EKS (namespace `app`), separate from the mock system |
| Thu Nov 19 | Step Functions + SQS integrated; dashboard served from ElastiCache           |
| Thu Nov 26 | Athena stats endpoints + charts; e2e happy path                              |

## 9. Glossary

- **Scenario**: a scripted incident (`scenarios/*.json`): fault, timing, allowed actions, valid fixes, scoring weights.
- **Session**: one user's attempt at a scenario. One DynamoDB item and one Step Functions execution. Only one session can be active at a time.
- **Fault**: a destructive change to the mock system, applied by the injector (infra repo).
- **Action**: something the user does from the action panel; sent to SQS `user-actions` and applied by the worker.
- **Valid fix**: an action listed in the scenario's `validFixes`.
- **Resolved**: a valid fix was applied **and** every mock service is healthy for 2 consecutive checks.
- **TTD / TTR**: time to detect (fault injected → user acknowledges) and time to resolve (fault injected → resolved), in seconds.
