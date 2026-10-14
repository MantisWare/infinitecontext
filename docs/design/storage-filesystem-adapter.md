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

**Commit:** write temp → `fsync` → **`link(temp, gen N+1)`** → `fsync` directory → prune generations below the retention window (keep the latest **two** live commits; on tombstone commits drop all prior generations). **`EEXIST`** → re-read and re-check conditions. **Deletes** append a **tombstone** generation. **Moves/renames** are not an adapter operation.

### Client-side move (`moveStorageObjectWithDek`)

Decrypt with the vault DEK, **preserve the source `enc.kid` and AAD `seq`**, re-encrypt for the destination key’s AAD, then `put` with `ifNoneMatch:*` and `delete` with `ifMatch` on the source etag. Explicit `kid` / `seq` / `dekVersion` options must match the source envelope and the DEK.

If the source `delete` fails its `ifMatch` check after the destination put succeeds, the helper throws **`partial_move`** with **`destinationEtag`** and **`sourceOutcome`**: **`rewritten`** (source still exists with a new generation) or **`deleted`** (source gone, e.g. concurrent delete).

Readers use the **highest generation only**. A corrupt newest generation is **`corrupt_storage`** (no silent fallback). Repair: call **`removeCorruptGeneration(key, gen)`** on the adapter instance (under lock; only when that generation fails validation).

## Concurrency

Conditional **`put` / `delete`** evaluate preconditions, then commit via **hard-link CAS** so a stall between lock refresh and commit cannot drop an acknowledged write. The **heartbeat lock** (`storage-objects.lock`) serializes writers; correctness is from **CAS**, not the lock alone.

**Symlinks** are rejected under the store root (`lstat` per segment, **`O_NOFOLLOW`** on read, **`realpath`** check after open).

## Synced-folder limits (iCloud, Dropbox, Google Drive, etc.)

For **one machine** or a **desktop-synced folder** with **last-writer-wins** caveats:

- Sync may produce **conflict copies**, **placeholders**, or delayed renames.  
- **Cross-machine CAS is not guaranteed** through the sync layer.  
- Prefer hosted/S3-style backends when multiple writers need strict preconditions.

## API notes

- **`list(prefix)`:** segment-based prefix. A trailing **`/`** requires a path separator after the prefix (`list('a/')` matches `a/x` but **not** `ab/x`).  
- **`list`** returns a **`corrupt`** array for keys whose newest generation fails validation (the listing continues).  
- Stale **`.ic-fs-tmp.*`** / **`.icgen.tmp.*`** files older than **1 hour** are swept on **`init`**.  
- **Tombstone-only** keys (deleted, never recreated) whose tombstone generation file is older than **7 days** (by **`mtime`**) are compacted on **`init`** under the objects lock: generation files are removed but **`.icgen-high-water`** keeps the last generation index so commits never regress (stale creates/replaces cannot resurrect deleted keys). Sweep skips corrupt keys instead of failing **`init`**.
