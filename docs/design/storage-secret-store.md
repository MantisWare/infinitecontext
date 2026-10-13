# Storage secret store (Phase 4.5 PR 3)

Backend credentials (S3 keys, WebDAV passwords, etc.) for pluggable storage must **never** be written to disk in plaintext.

## Backends

| Path | When | Persistence |
|------|------|-------------|
| **OS keychain** | `INFINITECONTEXT_SECRET_STORE=keyring`, or `auto` when no file store exists and a **durable** keychain is available | One keychain entry per secret name (`infinitecontext-storage` service) |
| **Encrypted file** | `INFINITECONTEXT_SECRET_STORE=file`, or `auto` fallback | `storage-secrets.enc` (mode **0600**), AEAD ciphertext |

### Encrypted file limits

The **KEK** (`storage-secrets.kek`, mode **0600**) sits **beside** the ciphertext file on disk. That design **only protects against casual exposure** (permissions, accidental copy, grep). Anyone with read access to both files can decrypt offline. Use the OS keychain when you need stronger isolation from disk backups.

Writes are **atomic** (temp file + `fsync` + rename + directory `fsync`) and refuse **symlinks** on store paths. Updates are serialized with a **lock file** so concurrent `set()` calls cannot clobber each other.

### Linux / headless / reboot

On Linux without a desktop **Secret Service** (no `DBUS_SESSION_BUS_ADDRESS`), `@napi-rs/keyring` often binds to the **kernel keyring**, which is **cleared on reboot**. **`auto` does not choose that backend** — it falls back to the encrypted file store. Set `INFINITECONTEXT_SECRET_STORE=keyring` only when you accept ephemeral kernel-keyring semantics (or when Secret Service is available). Override tests with `INFINITECONTEXT_KEYRING_DURABLE=0|1` if needed.

### `auto` selection

1. If **`storage-secrets.enc` exists** → always **file** (existing secrets are not silently ignored).
2. Else if a **durable** OS keychain is available → **keyring**.
3. Else → **file** (creates a new encrypted store).

Invalid `INFINITECONTEXT_SECRET_STORE` values are rejected (no silent fallback to `auto`).

To migrate from file → keychain: export secrets, remove `storage-secrets.enc` and `storage-secrets.kek`, then set `INFINITECONTEXT_SECRET_STORE=keyring`.

## API (js-sdk)

- `SecretStore` — `set(name, bytes)`, `get(name)`, `delete(name)`
- `resolveSecretStoreBackend({ mode, rootDir })` for tests and tooling

Secret names: `[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}`.
