# Backend Conventions

Rules for code in this repo. They're short so they can actually be followed. If one gets in the way, change it here in a PR and say why. Don't silently ignore it.

## 1. TypeScript and ESM

- `tsconfig`: `strict: true`, `module`/`moduleResolution: NodeNext`, `target: ES2023`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: false`.
- `package.json` has `"type": "module"`. **Relative imports include the `.js` extension** (`import { x } from "./sessions.service.js"`), even from `.ts` files. That's how NodeNext ESM resolves.
- No `any`. Use `unknown` and narrow it, usually with a zod parse. If `any` is truly needed, add a one-line comment saying why.
- Prefer `type` aliases inferred from zod (`type Session = z.infer<typeof SessionSchema>`) over hand-written interfaces for anything that crosses a boundary.
- Named exports only (no `export default`), so renames and searches stay reliable.
- No enums; use `as const` objects or zod enums.
- Dates: ISO-8601 UTC strings at boundaries (`new Date().toISOString()`); durations as integer seconds with the unit in the name (`ttrSeconds`).

## 2. Naming

| Thing                                  | Style                               | Example                                         |
| -------------------------------------- | ----------------------------------- | ----------------------------------------------- |
| Files                                  | kebab-case with a role suffix       | `sessions.routes.ts`, `mock-cluster.gateway.ts` |
| Types / schemas                        | PascalCase; schemas end in `Schema` | `SessionView`, `CreateSessionBodySchema`        |
| Functions / vars                       | camelCase, verbs for functions      | `startSession`, `isValidFix`                    |
| Constants                              | UPPER_SNAKE_CASE                    | `LOCK_KEY`                                      |
| JSON over HTTP                         | camelCase                           | `sessionId`                                     |
| DynamoDB attributes, event log, Athena | snake_case                          | `session_id`                                    |
| Env vars                               | UPPER_SNAKE_CASE                    | `SESSIONS_TABLE`                                |
| Error codes                            | UPPER_SNAKE_CASE                    | `SESSION_BUSY`                                  |

The camelCase ↔ snake_case mapping happens **only in repos** (`toItem` / `fromItem`). The rest of the code never sees snake_case.

## 3. Module structure

Each feature lives in `src/modules/<feature>/`:

```
sessions/
├── sessions.schemas.ts     zod schemas (+ OpenAPI registration) and inferred types
├── sessions.routes.ts      Express Router: parse → call service → respond. No logic.
├── sessions.service.ts     business logic; depends on interfaces, not SDKs
├── sessions.repo.ts        DynamoDB access (the only file that touches the SDK)
├── sessions.service.test.ts
└── index.ts                public surface of the module (what others may import)
```

Rules:

- **Dependency direction**: routes → service → repo/gateway → platform. Never the other way.
- Other modules import only from `modules/<x>/index.ts`, never from deep files.
- **Services take their dependencies as arguments** (simple factory functions, no DI framework):
  ```ts
  export function createSessionsService(deps: { repo: SessionsRepo; lock: Lock; orchestration: Orchestration; events: EventLog; clock: Clock }) { … }
  ```
  `src/app.ts` and `src/worker.ts` are the **composition roots**: the only place real implementations are wired together. Tests pass fakes.
- Inject a `Clock` (`now(): Date`) wherever time matters (scoring, TTLs, timeouts), so tests don't depend on real time.
- Pure logic (scoring, fix validation, state transition rules) goes in plain functions with no dependencies.
- Gateways with external side effects (`mock-cluster`, `orchestration`) define an **interface** and ship a fake next to the real one (`mock-cluster.fake.ts`).

## 4. Express 5

- Build the app in `createApp(deps)` (`src/app.ts`); `src/api.ts` only loads config, wires dependencies and calls `listen`. Tests use `createApp` with fakes and `supertest`.
- Async handlers can just `throw`; Express 5 forwards rejected promises to the error handler. No `try/catch` in routes just to call `next(err)`, and no `express-async-handler`.
- Validate with a shared middleware: `validate({ params, query, body })` using zod. In Express 5 `req.query` is read-only, so put parsed values on `res.locals.input` (typed helper) and don't assign to `req.query`.
- Middleware order: request id → pino-http → `express.json({ limit: "100kb" })` → health routes → auth → module routers → 404 → error handler.
- Express 5 path syntax: wildcards must be named (`/*splat`); no regex-ish strings like `/:id?`.
- Every route is registered in the OpenAPI registry with its schemas. If it isn't in `openapi.json`, it doesn't exist for the frontend.
- Status codes: 200 read, 201 create, 202 accepted (queued), 204 no body, 400 malformed, 401 no/invalid token, 404 not found **or not yours**, 409 state conflict, 422 valid shape but not allowed, 500 bug, 503 dependency down, 504 upstream timeout.
- **No `cors` package.** Use `app.disable("x-powered-by")` and set `trust proxy` to the number of proxies (CloudFront + ALB = 2) so `req.ip` is right.

## 5. Errors

- One base class: `AppError(code, httpStatus, message, details?)`, plus helpers (`notFound()`, `conflict(code)`, `unprocessable(code)`).
- The central error handler maps:
  - `AppError` → its status and code
  - `ZodError` → 400 `VALIDATION_ERROR` with issue paths
  - anything else → 500 `INTERNAL`
- The response body always follows the shape in ARCHITECTURE §6 and includes `requestId`.
- Never send stack traces or AWS error messages to the client. Log them.
- AWS SDK errors are translated in the repo/gateway layer. For example, `ConditionalCheckFailedException` becomes a domain error such as `SessionStateConflict`. Services never check SDK error names.

## 6. Configuration

- `src/config/` defines one zod schema for all env vars (ARCHITECTURE §9). It's parsed once at startup; **invalid or missing config crashes the process** with a readable message.
- Code reads `config.x`, never `process.env.X` (outside `config/`).
- `AUTH_MODE=dev` when `NODE_ENV !== "development"` must fail at startup.
- Every new variable is added to the schema, `.env.example` and ARCHITECTURE §9 in the same PR.

## 7. AWS SDK v3

- One client per service, created in `src/platform/aws.ts` from config (`region`, optional `endpoint` for LocalStack). Import only the clients and commands you use (`@aws-sdk/client-sqs`, not `aws-sdk`).
- **Never pass `credentials`.** The default chain provides them (LabRole on EKS, `~/.aws` locally, dummy keys for LocalStack).
- DynamoDB: use `DynamoDBDocumentClient` (`lib-dynamodb`) with `removeUndefinedValues: true`.
  - Every state change uses a `ConditionExpression`.
  - Counters use `ADD`.
  - Always use `ExpressionAttributeNames` (`#state`; `state` is a reserved word).
  - No `Scan`.
- SQS: long polling (`WaitTimeSeconds: 20`, `MaxNumberOfMessages: 10`); FIFO with `MessageGroupId = sessionId`; delete a message **only after** it was handled successfully.
- Step Functions: `StartExecution` with `name = sessionId`. Treat `ExecutionAlreadyExists` as success (idempotent retry); treat `TaskTimedOut`/`InvalidToken` as "already ended", log at warn and continue.
- Athena: only queries from `src/modules/stats/queries/*.sql`, run with `ExecutionParameters` (positional `?`), never string-built SQL. Always filter by partition and `user_id`.
- Rely on the SDK's built-in retries; don't add retry loops around SDK calls unless there's a specific reason.

## 8. Redis

- Every key has a TTL. Key names follow ARCHITECTURE §7.2; add new keys there.
- Use `SET key value NX PX ttl` for locks and idempotency. Release the lock with a compare-and-delete Lua script, never a plain `DEL`.
- Values are JSON validated with zod on read (a stale shape after a deploy must not crash the dashboard).
- Redis is never the only copy of durable data, except the per-session event buffer, which is a known limitation.

## 9. Kubernetes client (`mock-cluster` module only)

- Only `mock-cluster.gateway.ts` imports `@kubernetes/client-node`. `KubeConfig.loadFromDefault()` picks the in-cluster ServiceAccount in EKS and `~/.kube/config` (kind) locally.
- Always namespaced calls with `config.MOCK_NAMESPACE`; never cluster-wide.
- Every operation the gateway performs must have a matching RBAC rule in ARCHITECTURE §8.6 (and in the infra repo).
- Target names are checked against the scenario's `targets` **before** calling the API (no user-controlled resource names reach k8s unchecked).
- Health checks: HTTP GET with a 1.5 s timeout (`AbortSignal.timeout`); any non-2xx or timeout means unhealthy.

## 10. Worker loops

- Each loop (`consumer`, `monitor`) is an async function with an `AbortSignal`. On `SIGTERM`, stop receiving, finish in-flight messages (≤ 25 s), close Redis, exit 0.
- A failure in one message never kills the loop: catch, log with context, let SQS retry, continue.
- Handlers are **idempotent**: check `action:{actionId}` and the session state before doing anything.
- The monitor loop does nothing when `lock:active-session` is empty (no active session = no k8s calls).

## 11. Logging

- pino, JSON, one logger from `platform/logger.ts`; create child loggers with context (`logger.child({ sessionId, userId })`).
- Levels: `error` (needs a human), `warn` (unexpected but handled), `info` (state transitions, one line per request via pino-http), `debug` (details, off in prod).
- Always include `sessionId` / `actionId` / `requestId` when known.
- Redact `req.headers.authorization`, cookies and the task token. Never log full JWTs, credentials or the full scenario `validFixes` at info level.

## 12. Testing

- **Vitest**. Unit tests sit next to the code (`*.test.ts`); integration tests live in `test/integration/*.int.test.ts`.
- **Unit tests** (no network, no Docker): services with fakes, pure functions, routes through `supertest(createApp(fakes))`. Required for scoring, fix validation, state transitions, message parsing, lock behavior and auth middleware.
- **Integration tests** run against docker-compose (LocalStack + Redis). Each test file uses a unique table-key prefix or session ids and cleans up after itself. They test repos, the SQS consumer loop and the full start → action → resolve flow with `MOCK_CLUSTER=fake`.
- **No test talks to real AWS.**
- Use a fixed `Clock` for anything time-based.
- Name tests by behavior: `it("returns 409 SESSION_BUSY when another session holds the lock")`.
- Coverage isn't a gate, but `scoring` and `actions` validation should be near 100%.

## 13. OpenAPI

- Schemas are registered with `@asteasolutions/zod-to-openapi` in each module's `*.schemas.ts`. `pnpm openapi` writes `openapi/openapi.json`.
- The generated file is **committed**. CI regenerates it and fails if there's a diff.
- Breaking changes (removing or renaming a field, changing a type) need a heads-up to the frontend owner in the PR description.

## 14. Lint, format, dependencies

- ESLint (typescript-eslint, `recommended-type-checked`) + Prettier (default config, `printWidth: 100`). CI runs `pnpm lint`, `pnpm typecheck` and `pnpm test`.
- Rules worth keeping on: `no-floating-promises`, `consistent-type-imports`, `no-console` (use the logger).
- Add a dependency only if it saves real work. Exact versions come from `pnpm-lock.yaml`, which is always committed. Run `pnpm audit` in CI (warn only).

## 15. Docker

- Multi-stage: `deps` (pnpm fetch), `build` (tsc), `runtime` (`node:22-alpine`, prod deps only, `USER node`).
- One image runs both processes; the k8s manifest chooses `node dist/api.js` or `node dist/worker.js`.
- `.dockerignore` excludes `node_modules`, `.git`, tests, `.env*`.
- Images are tagged with the git SHA; `latest` is never used in AWS.

## 16. Git and PRs

- Branches from `main`: `feat/…`, `fix/…`, `chore/…`, `docs/…`, `test/…`. Short-lived.
- Conventional Commits: `feat(sessions): add global session lock`.
- PR description: what, why, how it was tested, and any contract change (and whether the frontend or infra needs to act).
- CI green before merge; the other teammate reviews when the PR touches a cross-repo contract.
- Docs move with code: contract changes go in `ARCHITECTURE.md`, decisions in `DECISIONS.md`.
