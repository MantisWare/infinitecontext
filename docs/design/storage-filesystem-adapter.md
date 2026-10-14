# Local filesystem storage adapter (Phase 4.5 PR 4)

`createFilesystemStorageAdapter({ rootDir })` stores **ciphertext-only** storage objects on a local directory tree. It implements the same `StorageAdapter` contract as the in-memory adapter (conditional puts, list pagination, atomic rename).

## Object key grammar

Keys are **canonical path strings** without a leading or trailing `/`:

- Segments match `[A-Za-z0-9._-]+` and are joined with `/`.
- Rejected: empty segments, `.`, `..`, segments starting with `.`, backslashes, and names reserved for temp/lock files (for example `.ic-fs-tmp.*`, `storage-objects.lock`).

## On-disk format (one file per object)

Each object is a **single file** at `{rootDir}/{key}` (intermediate directories created as needed):

1. **4-byte big-endian** header length
2. **JSON header** `{ etag, revision, size, modifiedAt }` (revision is read from disk on every operation)
3. **Raw ciphertext body** (storage object bytes)

Writes create an **`O_EXCL`** temp file (`.ic-fs-tmp.*`), `fsync` the file, `rename` into place, then `fsync` the directory. Stale temps older than **1 hour** are swept when the store opens.

## Concurrency

Conditional operations (`ifMatch`, `ifNoneMatch`, conditional delete, `rename`) re-check etags under a per-root **heartbeat lock** (`storage-objects.lock`, same mechanism as the secret store). The lock reduces contention; callers must still treat **`precondition_failed`** as a normal CAS loss and retry. **`assertHeld`** runs before commit; a lost lock surfaces as **`lock_compromised`**.

**Symlinks** are rejected anywhere under the store root (`lstat` per path segment, **`O_NOFOLLOW`** on read).

## Synced-folder limits (iCloud, Dropbox, Google Drive, etc.)

This backend is intended for **one machine** or a **desktop-synced folder** with **last-writer-wins** semantics:

- Sync services may leave **conflict copies**, **placeholder** files, or delay renames — **cross-machine CAS is not guaranteed** through the sync layer.
- Do not point multiple unsynchronized writers at the same synced path expecting strict CAS.
- For strict multi-writer correctness, use a backend with server-side preconditions (hosted / S3) rather than a synced folder.

## Use cases

- Dev and contract tests without a remote backend
- User-chosen synced folders when accepting the caveats above

## Limits

- Errors are surfaced as **`StorageError`** (`invalid_argument`, `permission_denied`, `corrupt_storage`, `precondition_failed`, etc.).
- `list` skips entries that disappear or fail validation mid-enumeration (for example a race with delete).
