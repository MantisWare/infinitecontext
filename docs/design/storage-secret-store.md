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

Writes are **atomic** (temp file + `fsync` + rename + directory `fsync`; failed writes remove the temp file) and refuse **symlinks** on store paths. Updates are serialized with a **heartbeat lock** (`storage-secrets.lock`, mode **0600**):

- The holder writes a random **token** and refreshes the lock file **mtime every ~2 s** while it holds the lock.
- A lock is **stale** only when its mtime is older than **~10 s** (no pid/hostname metadata).
- Stealing is serialized via a companion **`storage-secrets.lock.steal`** file (`O_EXCL`); staleness is **re-checked under the steal lock** before removing the main lock.
- Before every atomic commit (`rename`) and before release, the holder verifies the token still matches; mismatch → **`lock_compromised`** (no silent clobber).
- On acquire, orphaned temp files (`.storage-secrets.*.tmp.*`), old quarantine paths, and stale steal locks older than **1 h** are swept.

### Backend marker (`storage-secrets.backend`)

After the first successful backend selection, the concrete backend id (`file`, `secret-service`, `macos-keychain`, or `windows-credential`) is persisted in **`storage-secrets.backend`** (mode **0600**, atomic write). Legacy **`keyring`** in an existing marker file is normalized to the platform keychain id (`secret-service` on Linux, `macos-keychain` on macOS, `windows-credential` on Windows) when read — new writes always store the concrete id. Later sessions **always honor the marker** — no silent backend switch. Wrong platform or unavailable backend → **`migration_required`**. Explicit `INFINITECONTEXT_SECRET_STORE=file|keyring` must match the marker (`keyring` mode matches the platform keychain marker on the current OS).

### Linux: Secret Service only (never kernel keyring)

On Linux, InfiniteContext **never** uses the kernel keyutils keyring (`/proc/keys`). Before any `@napi-rs/keyring` access:

1. **`DBUS_SESSION_BUS_ADDRESS`** must be set.
2. The **`dbus-send`** CLI must be installed (e.g. `dbus-x11` / `dbus` package). If it is missing, explicit keyring mode fails with a clear error.
3. **`org.freedesktop.secrets`** must be reachable on the session bus (`dbus-send --session … NameHasOwner`, with timeout).
4. Entries are created with `{ linux: { store: 'secret-service' } }` so keyring-rs cannot fall back to kernel storage.
5. A **non-interactive probe** (set/delete in a child process, ~3s deadline) must succeed.

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
