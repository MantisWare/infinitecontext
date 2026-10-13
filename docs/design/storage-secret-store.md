# Storage secret store (Phase 4.5 PR 3)

Backend credentials (S3 keys, WebDAV passwords, etc.) for pluggable storage must **never** be written to disk in plaintext.

## Backends

| Marker value | Platform | When |
|--------------|----------|------|
| **`file`** | all | `INFINITECONTEXT_SECRET_STORE=file`, `auto` fallback, or existing `storage-secrets.enc` |
| **`secret-service`** | Linux | `keyring` / `auto` when D-Bus Secret Service is reachable and probe succeeds |
| **`macos-keychain`** | macOS | `keyring` / `auto` when keychain probe succeeds |
| **`windows-credential`** | Windows | `keyring` / `auto` when Credential Manager probe succeeds |

OS keychain entries use the `infinitecontext-storage` service name. Encrypted file persistence uses `storage-secrets.enc` (mode **0600**) with AEAD.

### Encrypted file limits

The **KEK** (`storage-secrets.kek`, mode **0600**) sits **beside** the ciphertext file on disk. That design **only protects against casual exposure** (permissions, accidental copy, grep). Anyone with read access to both files can decrypt offline. Use the OS keychain when you need stronger isolation from disk backups.

Writes are **atomic** (temp file + `fsync` + rename + directory `fsync`; failed writes remove the temp file) and refuse **symlinks** on store paths. Updates are serialized with a **lock file** (`storage-secrets.lock`) so concurrent `set()` calls cannot clobber each other. The lock file records **hostname, pid, and acquiredAt**. Stale locks are removed only when safe: **never** from a **live pid on the same host** (regardless of age); otherwise when the holder pid is dead, or (foreign host) the lock is older than 30 minutes. Stealing renames the lock to a quarantine path and re-validates before unlinking.

### Backend marker (`storage-secrets.backend`)

After the first successful backend selection, the concrete backend id (`file`, `secret-service`, `macos-keychain`, or `windows-credential`) is persisted in **`storage-secrets.backend`** (mode **0600**, atomic write). Legacy **`keyring`** markers are treated as the platform keychain id. Later sessions **always honor the marker** — no silent backend switch. Wrong platform or unavailable backend → **`migration_required`**. Explicit `INFINITECONTEXT_SECRET_STORE=file|keyring` must match the marker.

### Linux: Secret Service only (never kernel keyring)

On Linux, InfiniteContext **never** uses the kernel keyutils keyring (`/proc/keys`). Before any `@napi-rs/keyring` access:

1. **`DBUS_SESSION_BUS_ADDRESS`** must be set.
2. **`org.freedesktop.secrets`** must be reachable on the session bus (`dbus-send` with timeout).
3. Entries are created with `{ linux: { store: 'secret-service' } }` so keyring-rs cannot fall back to kernel storage.
4. A **non-interactive probe** (set/delete in a child process, ~3s deadline) must succeed.

If any step fails, **`auto`** uses the encrypted file store; explicit **`keyring`** fails fast. Probe results are **cached for the process**. Set `INFINITECONTEXT_KEYRING_DURABLE=0` to force `auto` to skip keychain selection.

### `auto` selection (no marker yet)

1. If **`storage-secrets.enc` exists** → always **file**.
2. Else if the platform keychain probe succeeds → platform marker (`secret-service`, etc.).
3. Else → **file** (creates a new encrypted store).

Invalid `INFINITECONTEXT_SECRET_STORE` values are rejected (no silent fallback to `auto`).

To migrate: export secrets, remove `storage-secrets.enc`, `storage-secrets.kek`, and `storage-secrets.backend`, then set `INFINITECONTEXT_SECRET_STORE=keyring` (or copy secrets to the other backend and update the marker).

## API (js-sdk)

- `SecretStore` — `set(name, bytes)`, `get(name)`, `delete(name)`; `backendKind()` returns the concrete marker id
- `resolveSecretStoreBackend({ mode, rootDir })` for tests and tooling

Secret names: `[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}`.
