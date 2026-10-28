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
# Note: openapi generation is coming soon in M1/M2
pnpm openapi                   # Regenerate openapi/openapi.json (coming soon)
pnpm build                     # Compile TypeScript to dist/
```
