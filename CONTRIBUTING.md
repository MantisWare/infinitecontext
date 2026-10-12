# Contributing

Thanks for your interest in contributing to InfiniteContext!

## Setup

```bash
git clone https://github.com/MantisWare/infinitecontext.git
cd infinitecontext
pnpm install
```

### Run the Context API locally

```bash
# start PostgreSQL
pnpm infinitecontext:db:up

# apply schema
pnpm infinitecontext:db:migrate

# generate a dev API key
pnpm infinitecontext:key:local

# start the API
pnpm infinitecontext:api
```

### Run the Context Hub locally

```bash
pnpm dev:sync      # start sync (daemon + TUI)
```

## Monorepo structure

| Directory | What it is |
|-----------|-----------|
| `apps/api` | Context API (Hono + Drizzle) |
| `apps/js-sdk` | Node.js SDK + CLI (`infinitecontext` npm package) |
| `apps/python-sdk` | Python SDK |
| `apps/sync` | Sync daemon + TUI (dev mode) |
| `apps/postgres` | Docker Compose + schema for local PostgreSQL |
| `apps/docs` | Documentation (Mintlify) |

## Commit conventions

We use [Conventional Commits](https://www.conventionalcommits.org):

```
feat(api): add new endpoint
fix(cli): resolve startup crash
docs: update quickstart guide
refactor(tui): simplify layout logic
```

## Before opening a PR

1. Open an issue first for large changes — let's discuss the approach before writing code.
2. Keep PRs focused — one feature or fix per PR.
3. Target `main`.

## Need help?

Open an issue or reach out on [Discord](https://discord.gg/infinitecontext).
