# Local default object store (Phase 4.5 PR 5)

Phase 4.5 PR 5 wires the **filesystem `StorageAdapter`** (PR 4) to the **sealed sync transport** (PR 1) as the default **on-disk ciphertext object store** for dev, tests, and synced-folder backends (iCloud/Dropbox/Google Drive desktop paths).

## Layout

| Path | Purpose |
|------|---------|
| `~/.infinitecontext/object-store/` | Default store root (`objects/`, heartbeat lock, temp sweep) |
| `config.json` → `storage.rootDir` | Optional override (supports `~/…`) |
| `INFINITECONTEXT_OBJECT_STORE_ROOT` | Env override (wins over config) |

## API (js-sdk)

- `defaultLocalObjectStoreRootDir()` — default path under `~/.infinitecontext`
- `resolveLocalObjectStoreRootDir({ env, config })` — env → config → default
- `createLocalObjectStore({ rootDir?, id?, maxObjectBytes? })` — `init()` filesystem adapter, return `{ rootDir, adapter, transport, close }`
- Production puts use `transport.putObject()` (sealed bodies only); see `docs/design/storage-object-security.md`

Object format, CAS, listing, and repair semantics: **`docs/design/storage-filesystem-adapter.md`**.

## Relation to other Phase 4.5 PRs

| PR | Scope |
|----|--------|
| 1 | `StorageAdapter` contract, memory adapter, `ObjectStoreSyncTransport` sealing |
| 2 | `SyncTransport` for hosted context sync (orthogonal to object store bytes) |
| 3 | `SecretStore` for backend credentials |
| 4 | `createFilesystemStorageAdapter` |
| **5** | **Default local object store factory + config resolution (this PR)** |

Future PRs: hosted/S3/WebDAV object backends, manifest CAS, CLI `infinitecontext storage …`.
