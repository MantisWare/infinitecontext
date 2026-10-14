# Local filesystem storage adapter (Phase 4.5 PR 4)

`createFilesystemStorageAdapter({ rootDir })` stores **ciphertext-only** storage objects on a local directory tree. It implements the same `StorageAdapter` contract as the in-memory adapter (conditional puts, list pagination, atomic rename).

## Layout

- Object body: `{rootDir}/{key}` (keys use `/`; `..` rejected)
- Sidecar metadata: `{rootDir}/{key}.ic-storage-meta` (etag, revision, `modifiedAt`, mode **0600**)
- Writes use temp file + `rename` in the object directory; store root is created at **0700** via `ensurePrivateDir`.

## Use cases

- Dev and contract tests without a remote backend
- User-chosen **synced folders** (iCloud Drive, Dropbox, Google Drive desktop) when the InfiniteContext home or a configured path points at the synced directory — same ciphertext bytes as other backends; see `docs/plan/infinitecontext-plan.md` §8.

## Limits

- Single-machine correctness for concurrent writers in **one process**; multi-process writers on the same folder need OS/file locking (future hardening).
- No server-side timestamps capability; etags are content-derived with a monotonic revision counter stored in metadata.
