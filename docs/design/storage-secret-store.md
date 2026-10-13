# Storage secret store (Phase 4.5 PR 3)

Backend credentials (S3 keys, WebDAV passwords, etc.) for pluggable storage must **never** be written to disk in plaintext.

## Behavior

| Path | When | Persistence |
|------|------|-------------|
| **OS keychain** | `@napi-rs/keyring` probe succeeds (`auto` default) | One keychain entry per secret name (`infinitecontext-storage` service) |
| **Encrypted file** | No OS keychain (`auto`) or `INFINITECONTEXT_SECRET_STORE=file` | `~/.infinitecontext/storage-secrets.enc` (mode **0600**), AEAD envelope via local 32-byte KEK in `storage-secrets.kek` (0600) |

`INFINITECONTEXT_SECRET_STORE=keyring` fails closed if the OS keychain is unavailable.

## API (js-sdk)

- `SecretStore` — `set(name, bytes)`, `get(name)`, `delete(name)`
- `resolveSecretStoreBackend({ mode, rootDir })` for tests and tooling

Secret names: `[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}`.
