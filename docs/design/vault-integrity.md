# Vault integrity (planned)

PR #5 ships **confidentiality only**: ciphertext on the wire and at rest, with **AAD v4** binding each envelope to `ic_client_node_id` and context. That stops cross-context ciphertext swaps and many injected-ciphertext attacks at decrypt time.

**Rollback, truncation, and reorder** of the message log are **not** covered in PR #5. A malicious or compromised API operator can still:

- Drop messages from responses
- Reorder messages within a version head
- Roll back a client to an older version head that omits newer messages

## Target design (follow-up PR)

### Per-context chain head (client-held)

Each client maintains a **local integrity head** per context, persisted alongside sync state (exact store TBD: daemon KV or `~/.infinitecontext/`):

| Field | Purpose |
|-------|---------|
| `context_id` | Root context public id |
| `head_version` | Latest version index the client has applied |
| `head_created_at` | Timestamp of that version head |
| `message_count` | Expected message count at that head (optional cross-check) |
| `integrity_mac` | HMAC over canonical head descriptor (algorithm TBD in implementation PR) |

On every successful read/append/update, the client advances the head when the server reports a **monotonic** version index and consistent message count. On read, if the server snapshot regresses (lower version, missing ids, or bad decrypt), the client **refuses to apply** the snapshot and surfaces an integrity warning.

### Update and delete semantics

- **Append**: new messages must extend the chain; head MAC includes tail message ids or a rolling hash.
- **Update (COW)**: new version head must reference the previous head; client rejects forks that skip indices.
- **Delete**: soft delete creates a new version; client records deleted stable ids so rollback cannot resurrect them without detection.

### Rollback model

The server remains untrusted for ordering. Detection is **client-side**:

1. Compare server `version` and per-message stable `ic_client_node_id` set against the persisted head.
2. Optional future server assist: signed read receipts (out of scope until product requires it).

Until this ships, see **Known limits** in [vault-zero-knowledge.md](../vault-zero-knowledge.md).
