# Zero-knowledge vault (Phases 2–3)

InfiniteContext encrypts **all context node payloads on the client** before they reach the API. The hosted service stores only ciphertext plus minimal cleartext index metadata.

## Cryptography

| Layer | Algorithm | Notes |
|-------|-----------|--------|
| Vault passphrase → KEK | Argon2id (64 MiB, t=3, p=4) | Per-user salt in `user_crypto`; **not** the server login password hash |
| Data encryption (DEK) | Random 256-bit DEK | One DEK per user account |
| Node payloads | XChaCha20-Poly1305 (`XC20P`) | `@noble/ciphers`; **AAD v4** binds user id, context id, dek version, field, and stable **`ic_client_node_id`** (cleartext metadata, survives COW). Legacy v3 (ordinal index) is decrypt-only. |
| DEK wrap | XChaCha20-Poly1305 | Dual wrap: vault passphrase KEK + recovery key KEK |

Envelope stored in `nodes.content` / sensitive metadata:

```json
{
  "__ic_enc": 1,
  "kid": "dek_v1",
  "v": 1,
  "alg": "XC20P",
  "nonce": "<base64>",
  "ct": "<base64>"
}
```

### Server-side filters (v1 — accepted leakage)

**Decision (Waldo v1):** accept cleartext index fields below; **blind indexes** remain a later item.

Message bodies and all other metadata fields are encrypted (`ic_sensitive` envelope). These metadata keys stay **cleartext** on the server so `GET /contexts` filters keep working:

| Field | What leaks to the operator |
|-------|----------------------------|
| `source` | Agent/source enum (e.g. `claude`, `codex`) |
| `user_id` | Daemon user id string |
| `host` | Hostname string |
| `project_path` | Filesystem path string (still cleartext for server-side filters; encrypt sensitive path details inside `ic_sensitive` if needed) |
| `session_id` | Upstream agent session id |

Everything else (notes, titles, custom tags, message text, etc.) must be ciphertext once the vault is initialized.

## Known limits (confidentiality-only)

Until [vault integrity](../design/vault-integrity.md) ships, a **malicious or compromised server** can **roll back**, **drop**, or **reorder** messages in API responses without breaking decryption. Clients trust the version head the server returns. AAD v4 still prevents swapping ciphertext between contexts or client node ids.

Cleartext **`ic_chain_index` / `ic_chain_link`** fields may appear on older rows from preview builds; they are **ignored** in PR #5 and carry no security guarantee.

**`X-IC-Vault-Migrate-Read`** is rate-limited in memory **per API process** (not cluster-wide). Large migrate-project runs retry on **429**; multi-instance deployments should stagger migrates until [issue #3](https://github.com/MantisWare/infinitecontext/issues/3) adds a distributed limiter.

## Key recovery (strict zero-knowledge)

See [plan §7.1](/docs/plan/infinitecontext-plan.md).

**If you lose both your vault passphrase and your recovery key, your data is permanently lost.** InfiniteContext cannot decrypt or reset the vault.

- Email signup: set a vault passphrase at `infinitecontext vault init`; save the one-time recovery key.
- Google signup: run `infinitecontext vault init` (use `--google-account` if you rely on a vault passphrase instead of login password) **or** save the recovery key before syncing encrypted data.

## CLI

```bash
infinitecontext vault init                 # creates DEK + dual wrap; shows recovery key once
infinitecontext vault unlock               # passphrase → cache DEK (OS keychain when available; else background vault-agent)
  # Non-interactive: --passphrase-file=PATH or --passphrase-stdin (avoid INFINITECONTEXT_VAULT_PASSPHRASE — visible in /proc on Linux)
infinitecontext vault unlock --recovery    # recovery key unlock (new device)
infinitecontext vault lock
infinitecontext vault change-passphrase    # re-wrap DEK only
infinitecontext vault rotate-recovery-key
infinitecontext vault migrate-encrypt <ctx-id>   # opt-in plaintext → ciphertext
infinitecontext vault migrate-project            # encrypt all contexts; prunes old plaintext version heads when done
infinitecontext vault devices list
infinitecontext vault devices revoke <session-public-id>
```

Cached unlock TTL defaults to 15 minutes (`INFINITECONTEXT_VAULT_TTL_SEC` overrides).

When OS keychain (`keytar`) is unavailable, `vault unlock` starts a **detached background vault-agent** (Unix socket + PID under `~/.infinitecontext/`, mode `0600`) that holds the DEK until idle timeout or `infinitecontext vault lock`. Sync and other CLIs talk to that agent so they keep working after the unlock command exits. An optional `vault-cache.enc` file holds only ciphertext sealed by an in-memory session key (never a plaintext DEK on disk). `vault lock` stops the agent and wipes memory, keychain entries, and cache files.

## Threat model (summary)

| Threat | Mitigation |
|--------|------------|
| DB breach | Ciphertext only; no DEK/KEK on server |
| API operator | Zero-knowledge; no decrypt path |
| Weak vault passphrase | Argon2id + user education |
| Lost credentials | Recovery key; explicit data-loss UX |
| Revoked device | Session revoked; cannot refresh JWT to fetch crypto metadata |

Out of scope for Phases 2–3: malware on an unlocked device, side channels, and legal/compliance review of recovery UX copy.
