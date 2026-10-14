# Local filesystem storage adapter (Phase 4.5 PR 4)

`createFilesystemStorageAdapter({ rootDir })` stores **ciphertext-only** storage objects on a local directory tree with **generation-based CAS commits** (same pattern as the secret store in PR #17).

## Object key grammar

Keys are **lowercase** path strings without a leading or trailing `/`:

- Segments match `[a-z0-9._-]+` and are joined with `/`.
- **Uppercase is rejected** so keys stay stable on case-insensitive volumes (APFS default, Windows).
- Rejected: empty segments, `.`, `..`, segments starting or **ending with `.`**, backslashes, **Windows reserved names** (`con`, `nul`, `prn`, `aux`, `com1`–`com9`, `lpt1`–`lpt9`), and temp/lock reserved names.

## On-disk format

Each logical key has a directory under `{rootDir}/objects/<key-as-dirs>/` containing generation files **`000000000000001.icgen`** (12-digit gen):

1. **4-byte big-endian** header length  
2. **JSON header** `{ etag, revision, size, modifiedAt, tombstone? }` — **etag must match** a hash of the body on read  
3. **Ciphertext body**

**Commit:** write temp → `fsync` → **`link(temp, gen N+1)`** → `fsync` directory → prune gens **older than N−2**. **`EEXIST`** → re-read and re-check conditions. **Deletes** append a **tombstone** generation. **Renames** tombstone the source and create the destination in separate CAS steps (both under the store lock).

Readers use the **highest generation only**. A corrupt newest generation is **`corrupt_storage`** (no silent fallback). Repair: remove the bad generation file (future: `removeCorruptGeneration(key, gen)` on the adapter instance).

## Concurrency

Conditional **`put` / `delete` / `rename`** evaluate preconditions, then commit via **hard-link CAS** so a stall between lock refresh and commit cannot drop an acknowledged write. The **heartbeat lock** (`storage-objects.lock`) serializes writers; correctness is from **CAS**, not the lock alone.

**Symlinks** are rejected under the store root (`lstat` per segment, **`O_NOFOLLOW`** on read, **`realpath`** check after open).

## Synced-folder limits (iCloud, Dropbox, Google Drive, etc.)

For **one machine** or a **desktop-synced folder** with **last-writer-wins** caveats:

- Sync may produce **conflict copies**, **placeholders**, or delayed renames.  
- **Cross-machine CAS is not guaranteed** through the sync layer.  
- Prefer hosted/S3-style backends when multiple writers need strict preconditions.

## API notes

- **`list(prefix)`:** a trailing slash matters — `list('a/')` matches `a/x` but **not** `ab/x`.  
- **`list`** throws **`corrupt_storage`** when a listed object fails validation (does not skip silently).  
- Stale **`.ic-fs-tmp.*`** files older than **1 hour** are swept on **`init`**.
