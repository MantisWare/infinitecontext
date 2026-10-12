# Centralized sync (Phase 4)

Account-scoped **pull + push** sync over the hosted API. Each user has a monotonic **server sequence** (cursor). Clients pull with `GET /sync/changes?since=<cursor>` and push idempotent mutation batches with stable **`icn_*` client ids**.

## Where sync is available

| Deployment | `/sync/*` | Notes |
|------------|-----------|--------|
| **Node API + PostgreSQL (Drizzle)** | Supported | Default self-hosted and production Node entrypoint (`apps/api/server.ts`). |
| **Cloudflare Workers + Supabase REST** | **503** `sync_api_unavailable` | No Drizzle sync repository; use `/contexts` only on Workers until a Supabase adapter ships. |
| **Legacy API key (no user session)** | **403** on `/sync/*` | Sync is per-user JWT; API keys keep using `/contexts`. |

The CLI maps 503 to a plain-language error (see `lib/sync-errors.mjs`).

## API (session JWT required)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/sync/status` | `head_sequence`, `pending_conflicts` |
| GET | `/sync/changes?since=&limit=` | Paginated change log (default limit 500, max 1000) |
| GET | `/sync/conflicts?since=` | Unresolved conflict records |
| POST | `/sync/push` | `{ "mutations": [ … ] }` → `{ head_sequence, applied, duplicate, conflicts, effects }` |

### Mutation ops (push)

| Op | Meaning |
|----|---------|
| `context_create` | New root context |
| `context_fork` | `createContext` with `from` / version selectors |
| `context_metadata` | LWW root metadata (`updated_at` / `ic_metadata_updated_at`) |
| `message_append` | Append-only messages (`icn_*` ids) |
| `message_update` | Versioned message patch |
| `message_delete` | Versioned message delete |
| `context_delete` | Permanent context delete |
| `contexts_delete_many` | Batch delete |
| `prune_plaintext_versions` | Vault migrate helper |

**Rate limits (per user, in-memory per API process):** 120 pulls/min, 60 pushes/min.

## Zero-knowledge

Sync push paths use the same vault plaintext gates as `/contexts`. The server stores only ciphertext envelopes for vault accounts.

## Daemon transport (account sessions)

When signed in (no legacy API key):

- **Writes:** `create` / `append` go through **`POST /sync/push`** (`lib/sync-push-client.mjs`), with vault encryption applied first when the vault is unlocked.
- **Reads:** each daemon cycle **`GET /sync/changes`** (via `lib/sync-engine.mjs` pull) into `daemon.db` replica tables — not full `GET /contexts` list polling.

Legacy **`INFINITECONTEXT_API_KEY`** mode keeps direct `/contexts` writes (no sync cursor).

## Change log completeness (user JWT on `/contexts`)

For MCP, SDK, or migrate tooling that still calls `/contexts`, the API **mirrors** successful writes into the sync change log:

| Route | Sync op recorded |
|-------|------------------|
| `POST /contexts` | `context_create` or `context_fork` |
| `POST /contexts/:id` | `message_append` (per `icn_*`) |
| `PATCH /contexts/:id` | `message_update` |
| `DELETE /contexts/:id` (messages) | `message_delete` |
| `DELETE /contexts/:id` (permanent) | `context_delete` |
| `POST /contexts/delete-many` | `contexts_delete_many` |
| `POST /contexts/:id/prune-plaintext-versions` | `prune_plaintext_versions` |

`POST /sync/push` writes the log inside the sync service (no double-record with `/contexts`).

## CLI

```bash
infinitecontext sync status    # daemon ctl + server cursor
infinitecontext sync pull      # apply changes since local cursor (~/.infinitecontext/sync-state.json)
infinitecontext sync push      # flush local outbox
infinitecontext sync devices   # list devices
infinitecontext sync devices revoke <session-public-id>
```

Device list/revoke uses `/auth/devices` (revoking invalidates refresh tokens for that session).

## Local replica

The sync daemon pulls each cycle into `daemon.db` tables `sync_context_meta` and `sync_message_nodes`. Conflict UI is Phase 5; conflicts are exposed in API/CLI JSON only.

## Migration

Postgres migration `006_sync_api.sql` (verified by `apps/postgres/scripts/verify-migration-chain.sh`).
