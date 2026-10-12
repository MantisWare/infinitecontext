# Zero-knowledge vault (Phases 2–3)

InfiniteContext encrypts **all context node payloads on the client** before they reach the API. The hosted service stores only ciphertext plus minimal cleartext index metadata.

## Cryptography

| Layer | Algorithm | Notes |
|-------|-----------|--------|
| Vault passphrase → KEK | Argon2id (64 MiB, t=3, p=4) | Per-user salt in `user_crypto`; **not** the server login password hash |
| Data encryption (DEK) | Random 256-bit DEK | One DEK per user account |
| Node payloads | XChaCha20-Poly1305 (`XC20P`) | `@noble/ciphers`; AAD binds user id, context id, dek version, field |
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

### Server-side filters (v1)

Message bodies and rich metadata are encrypted. These metadata keys stay **cleartext** so `GET /contexts` filters keep working: `source`, `user_id`, `host`, `project_path`, `session_id`.

## Key recovery (strict zero-knowledge)

See [plan §7.1](/docs/plan/infinitecontext-plan.md).

**If you lose both your vault passphrase and your recovery key, your data is permanently lost.** InfiniteContext cannot decrypt or reset the vault.

- Email signup: set a vault passphrase at `infinitecontext vault init`; save the one-time recovery key.
- Google signup: run `infinitecontext vault init` (use `--google-account` if you rely on a vault passphrase instead of login password) **or** save the recovery key before syncing encrypted data.

## CLI

```bash
infinitecontext vault init                 # creates DEK + dual wrap; shows recovery key once
infinitecontext vault unlock               # passphrase → cache DEK (OS keychain when available)
infinitecontext vault unlock --recovery    # recovery key unlock (new device)
infinitecontext vault lock
infinitecontext vault change-passphrase    # re-wrap DEK only
infinitecontext vault rotate-recovery-key
infinitecontext vault migrate-encrypt <ctx-id>   # opt-in plaintext → ciphertext
infinitecontext vault devices list
infinitecontext vault devices revoke <session-public-id>
```

Cached unlock TTL defaults to 15 minutes (`INFINITECONTEXT_VAULT_TTL_SEC` overrides).

## Threat model (summary)

| Threat | Mitigation |
|--------|------------|
| DB breach | Ciphertext only; no DEK/KEK on server |
| API operator | Zero-knowledge; no decrypt path |
| Weak vault passphrase | Argon2id + user education |
| Lost credentials | Recovery key; explicit data-loss UX |
| Revoked device | Session revoked; cannot refresh JWT to fetch crypto metadata |

Out of scope for Phases 2–3: malware on an unlocked device, side channels, and legal/compliance review of recovery UX copy.
