# Storage secret store (Phase 4.5 PR 3)

Backend credentials (S3 keys, WebDAV passwords, etc.) for pluggable storage must **never** be written to disk in plaintext.

## Backends

| Marker value | Platform | When |
|--------------|----------|------|
| **`file`** | all | `INFINITECONTEXT_SECRET_STORE=file`, `auto` fallback, or existing `storage-secrets.enc` |
| **`secret-service`** | Linux | `keyring` / `auto` when D-Bus Secret Service is reachable and probe succeeds |
| **`macos-keychain`** | macOS | `keyring` / `auto` when keychain probe succeeds |
| **`windows-credential`** | Windows | `keyring` / `auto` when Credential Manager probe succeeds |

OS keychain entries use the `infinitecontext-storage` service name. Encrypted file persistence uses generation files **`storage-secrets.<gen>.enc`** (12-digit zero-padded `gen`, mode **0600**) with AEAD. Legacy single-file **`storage-secrets.enc`** is migrated to generation `1` on first access.

### Encrypted file limits

The **KEK** (`storage-secrets.kek`, mode **0600**) sits **beside** the ciphertext generations on disk. That design **only protects against casual exposure** (permissions, accidental copy, grep). Anyone with read access to both files can decrypt offline. Use the OS keychain when you need stronger isolation from disk backups.

**Correctness** comes from a filesystem **compare-and-swap**, not from the lock alone. The heartbeat lock reduces contention; it is not the commit fence.

- **Write (under lock):** read generation `N`, apply change, write + fsync a temp file, then **`fs.linkSync(temp, storage-secrets.<N+1>.enc)`**. `EEXIST` means another writer committed first → re-read and retry while the lock is still held. Lost lock → **`store_retry`** (caller may retry). If the **link succeeded** but a later step (directory fsync, temp unlink, or your process) errors, generation **N+1 may already be on disk** — callers must **retry idempotently** (re-read and apply the same logical change).
- **Read:** only the **highest-numbered** generation file is used. If that file is corrupt or fails validation, operations fail with **`corrupt_secret_store`** naming the path — **no silent fallback** to older generations.
- After a successful link: fsync the directory, unlink the temp, prune generations **older than N−2**.
- Requires **hard-link** support (local ext4/APFS/NTFS). Network or copy-on-write filesystems without link may fail with **`not_supported`**.

Marker/backend files and the KEK still use temp + rename. Secret payloads never use rename-to-commit.

### Heartbeat lock (`storage-secrets.lock`)

- Random **token**; holder refreshes lock **mtime every ~2 s**.
- Main lock stale when mtime **> ~10 s** behind wall clock, or **> ~60 s in the future** (clock skew between hosts is **not** a correctness signal — CAS still prevents lost writes; skew only affects steal timing).
- **`storage-secrets.lock.steal`** serializes stealing (`O_EXCL`); stale steal files (**> ~10 s**) are removed. Staleness is re-checked under the steal lock.
- Token checked before each CAS link and before release; mismatch → **`lock_compromised`**.
- On acquire, sweep only our orphan names (`.storage-secrets.*.tmp.*`, `.storage-secrets.lock.tmp.*`, `storage-secrets.lock.steal`, `storage-secrets.lock.quarantine.*`) when older than **1 h**.

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
