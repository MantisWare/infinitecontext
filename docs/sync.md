# Centralized sync (Phase 4)

Account-scoped **pull + push** sync over the hosted API. Each user has a monotonic **server sequence** (cursor). Clients pull with `GET /sync/changes?since=<cursor>` and push idempotent mutation batches with stable **`icn_*` client ids**.

## API (session JWT required)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/sync/status` | `head_sequence`, `pending_conflicts` |
| GET | `/sync/changes?since=&limit=` | Paginated change log (default limit 500, max 1000) |
| GET | `/sync/conflicts?since=` | Unresolved conflict records |
| POST | `/sync/push` | `{ "mutations": [ … ] }` → `{ head_sequence, applied, duplicate, conflicts, effects }` |

Mutations:

- `context_create` — `{ client_id, op, payload: { metadata } }`
- `context_metadata` — LWW on root metadata via `updated_at` / `ic_metadata_updated_at`
- `message_append` — append-only merge; duplicate `icn_*` ids are idempotent

**Rate limits (per user, in-memory per API process):** 120 pulls/min, 60 pushes/min.

## Zero-knowledge

Sync push paths use the same vault plaintext gates as `/contexts`. The server stores only ciphertext envelopes for vault accounts. Daemon ingestion still writes through the context API; the API records matching entries in the sync change log for pulls.

## CLI

```bash
infinitecontext sync status    # daemon + server cursor
infinitecontext sync pull      # apply changes since local cursor (~/.infinitecontext/sync-state.json)
infinitecontext sync push      # flush local outbox
infinitecontext sync devices   # list devices
infinitecontext sync devices revoke <session-public-id>
```

Device list/revoke uses `/auth/devices` (revoking invalidates refresh tokens for that session).

## Local replica

The sync daemon pulls each cycle into `daemon.db` tables `sync_context_meta` and `sync_message_nodes` (for TUI/offline read models). Conflict UI is Phase 5; conflicts are exposed in API/CLI JSON only.

## Migration

Postgres migration `006_sync_api.sql` (verified by `apps/postgres/scripts/verify-migration-chain.sh`).
