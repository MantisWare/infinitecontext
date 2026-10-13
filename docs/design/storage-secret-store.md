# Storage secret store (Phase 4.5 PR 3)

Backend credentials (S3 keys, WebDAV passwords, etc.) for pluggable storage must **never** be written to disk in plaintext.

## Backends

| Path | When | Persistence |
|------|------|-------------|
| **OS keychain** | `INFINITECONTEXT_SECRET_STORE=keyring`, or `auto` when no file store exists and a **durable** keychain is available | One keychain entry per secret name (`infinitecontext-storage` service) |
| **Encrypted file** | `INFINITECONTEXT_SECRET_STORE=file`, or `auto` fallback | `storage-secrets.enc` (mode **0600**), AEAD ciphertext |

### Encrypted file limits

The **KEK** (`storage-secrets.kek`, mode **0600**) sits **beside** the ciphertext file on disk. That design **only protects against casual exposure** (permissions, accidental copy, grep). Anyone with read access to both files can decrypt offline. Use the OS keychain when you need stronger isolation from disk backups.

Writes are **atomic** (temp file + `fsync` + rename + directory `fsync`; failed writes remove the temp file) and refuse **symlinks** on store paths. Updates are serialized with a **lock file** (`storage-secrets.lock`) so concurrent `set()` calls cannot clobber each other. The lock file records **hostname, pid, and acquiredAt**; stale locks (dead pid or older than 30 minutes) are taken over so a `kill -9` while holding the lock cannot wedge the store forever.

### Backend marker (`storage-secrets.backend`)

After the first successful backend selection, the chosen backend (`file` or `keyring`) is persisted in **`storage-secrets.backend`** (mode **0600**, atomic write). Later sessions **always honor the marker** — the store does not silently switch backends. If the marked backend is unavailable (for example keyring locked), operations fail with a **migration** error that tells you to unlock Secret Service or migrate secrets and remove the marker. Explicit `INFINITECONTEXT_SECRET_STORE=file|keyring` must match the marker or resolution fails.

### Linux / headless / reboot

On Linux without a responsive **Secret Service**, `@napi-rs/keyring` may bind to the **kernel keyring**, which is **cleared on reboot** and can **hang** on GUI unlock prompts. **`auto` does not rely on `DBUS_SESSION_BUS_ADDRESS`** — it runs a **short non-interactive probe** (set/delete in a child process with a deadline). If the probe fails or times out, **`auto` falls back to the encrypted file store**. Explicit **`keyring`** fails fast with a clear error when the probe fails. Set `INFINITECONTEXT_KEYRING_DURABLE=0` to force `auto` to skip keyring; `=1` still requires a passing probe.

### `auto` selection (no marker yet)

1. If **`storage-secrets.enc` exists** → always **file** (existing secrets are not silently ignored).
2. Else if the **Secret Service probe** succeeds → **keyring**.
3. Else → **file** (creates a new encrypted store).

Invalid `INFINITECONTEXT_SECRET_STORE` values are rejected (no silent fallback to `auto`).

To migrate from file → keychain: export secrets, remove `storage-secrets.enc`, `storage-secrets.kek`, and `storage-secrets.backend`, then set `INFINITECONTEXT_SECRET_STORE=keyring`.

## API (js-sdk)

- `SecretStore` — `set(name, bytes)`, `get(name)`, `delete(name)`
- `resolveSecretStoreBackend({ mode, rootDir })` for tests and tooling

Secret names: `[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}`.
