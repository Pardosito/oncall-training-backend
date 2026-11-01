# On-Call Training — Backend

**On-Call Training** is a web app where students and junior SDE/SREs practice handling a production incident. A user starts a scenario: a real (mock) distributed system runs in Kubernetes (EKS), and a fault is injected into it. The user watches a live dashboard, diagnoses the problem, and fixes it from a panel of predefined actions. The system detects recovery, computes a score (time to detect, time to resolve, wrong actions) and stores it in DynamoDB. Users can then view their performance over time in charts powered by Athena queries.

This repository hosts the **API** (Express HTTP server) and the **worker** (consumes user actions, monitors the mock system, detects resolution).

## Related Repositories

- [oncall-training-frontend](https://github.com/Pardosito/oncall-training-frontend): React SPA that consumes this backend's OpenAPI specification.
- [oncall-training-infra](https://github.com/Pardosito/oncall-training-infra): Terraform, Kubernetes manifests, Step Functions definitions, fault injector, and mock services.

## Documentation

- [AGENTS.md](AGENTS.md): Project overview, scope, stack, architecture summary, and rules for contributors and AI agents.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): System components, data flows, HTTP API routes, and cross-repo contracts.
- [docs/CONVENTIONS.md](docs/CONVENTIONS.md): Coding guidelines, error handling, typing standards, and testing conventions.
- [docs/DECISIONS.md](docs/DECISIONS.md): Architectural decisions, rationale, trade-offs, and future improvements.
- [docs/BACKLOG.md](docs/BACKLOG.md): Full issue backlog organized by milestones.

## Quickstart

```bash
# 1. Install dependencies
pnpm install

# 2. Local environment (LocalStack + Redis)
# Note: docker-compose configuration is coming soon in M1
docker compose up -d

# 3. Start development servers
pnpm dev                       # API on :3000 (tsx watch)
pnpm dev:worker                # Worker on :3001 (tsx watch)

# 4. Testing
pnpm test                      # Unit tests (Vitest, no Docker required)
pnpm test:integration          # Integration tests (runs against LocalStack + Redis)

# 5. Quality checks
pnpm lint                      # ESLint (type-checked)
pnpm typecheck                 # TypeScript type check (tsc --noEmit)
pnpm format:check              # Prettier format check (or pnpm format to format)

# 6. Build & OpenAPI
pnpm openapi                   # Regenerate openapi/openapi.json (commit it; CI fails if stale)
pnpm build                     # Compile TypeScript to dist/
```

## Docker image and release

One image runs both processes: `node dist/api.js` (default) or `node dist/worker.js`.

```bash
docker buildx build --platform linux/amd64 -t oncall-backend:local --load .
docker run --rm --read-only -p 3000:3000 --env-file .env oncall-backend:local
```

Always build for `linux/amd64`: the EKS nodes are x86_64, and an ARM image crashes there with `exec format error`.

**Pushing to ECR** is done only by the `Release` workflow (Actions → Release → Run workflow):

1. Refresh the Learner Lab credentials. The repo secrets `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN` expire with each lab session; the infra repo's `make creds` updates them in all three repos.
2. Run the workflow on the commit to release. It pushes `oncall-training/backend:<short git sha>` (tags are immutable, never `latest`).
3. Give infra the tag from the run summary; they roll it out with `make deploy`.

What the infra manifests need (ports, probes, env vars, replicas, RBAC) is in [docs/ARCHITECTURE.md §12](docs/ARCHITECTURE.md#12-deployment-contract-for-the-infra-repos-manifests).
