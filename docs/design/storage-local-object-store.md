# Local default object store (Phase 4.5 PR 5)

Phase 4.5 PR 5 wires the **filesystem `StorageAdapter`** (PR 4) to the **sealed sync transport** (PR 1) as the default **on-disk ciphertext object store** for dev and tests on a **non-synced** path (`~/.infinitecontext/object-store/` or an explicit root). Desktop-synced directories (iCloud, Dropbox, OneDrive, Google Drive under `~/Library/CloudStorage`, etc.) must use **`storage.backend=folder`**, not `local`.

For **iCloud Drive or any desktop-synced directory**, set `storage.backend` to `folder` and `storage.folder.path` to the synced folder (see `createFolderObjectStore` / `createFolderStorageAdapter`). Do **not** point `backend=local` at synced paths — local refuses known iCloud/Dropbox/Google Drive/OneDrive/Nextcloud roots and directs you to `folder`. The folder backend wraps the same filesystem object store with **honest capabilities** (local create-only, no **`crossDeviceCas`**), **file-level conflict-copy ingestion** (including duplicate `.icgen` and high-water files), and **iCloud placeholder** handling (`evicted_placeholder`).

**Folder-specific policy:**

- **Log segment GC and compaction/snapshot writes are disabled** on `folder` (and any backend without **`crossDeviceCas`**). Segments are never deleted; clients replay from **seq 0**. Forked snapshot copies are ignored when logs verify.
- **No shared manifest LWW.** Sync coordination uses **per-device** `devices/<devH>.json.enc` contributions (owner-writable). The effective manifest is a deterministic **union / max** merge across device files. Lease locks are not relied on for correctness on folder.
- **Conflict preflight** applies to **`log/` and `devices/`** on init/pull/push: file-level duplicate `.icgen` files use the same rules as segments (**`storage_fork`** vs **`corrupt_storage`**); device rows never silently disappear when a sidecar is unreadable.
- **Backend switch:** **`manifestGenerationHighWaterByBindingKey`** stores a separate manifest high-water per **`storageBindingKey`** (`<backendId>:<realpath>` of the **effective `rootDir`**). A **new** object root gets a **fresh** high-water entry; legacy scalar state migrates into the current binding on first open. **Symlinked store roots are refused** (`storage init` and open). Provider manifest rollback below the binding’s high-water on the same root is rejected.
- **CLI:** `infinitecontext storage init` (**folder** roots may live inside synced trees; **`backend=local`** refuses them), `storage doctor` (**read-only** — does not touch the folder root; chain verify plus trusted-head / high-water audit against **`~/.infinitecontext/object-store-sync-state.json`** and **all configured `daemon.db` files** (always **`~/.infinitecontext/daemon.db`**, plus **`INFINITECONTEXT_DB_FILE`** when it points elsewhere), and **`storage migrate`** (**crash-safe** atomic copies, resumable local→folder, destination identity re-checks, same trust sources as doctor before **`--apply-config`**; **`--reset`** refused after apply or when config already uses the destination). See **`docs/design/storage-layout.md`** § CLI maintenance.
- **Evicted segments:** placeholder-only key dirs (no materialized **`.icgen`**) surface **`evicted_placeholder`** on list, preflight, push, and pull.
- **`storage doctor --repair`** refuses when copy folders differ and prints a **manual resolution hint** (device + seq); quarantine is **deduped** when an identical tree is already under `quarantine/`.
- `infinitecontext config doctor` reports folder GC/manifest policy when `storage.backend=folder`.

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

Future PRs: hosted/S3/WebDAV object backends, manifest CAS, additional `infinitecontext storage …` backends.
