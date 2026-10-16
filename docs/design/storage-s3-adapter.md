# S3 / S3-compatible object store (Phase 4.5 #10)

Remote ciphertext object storage using the **`StorageAdapter`** contract over **S3 API** (AWS S3, MinIO, Cloudflare R2, Backblaze B2, Wasabi, etc.). Logical object keys match the filesystem adapter grammar (`accounts/.../ic-v1/...`); bytes on wire are the same sealed storage JSON as local/folder backends.

## Invariants

1. **Credentials never in config or logs.** Bucket, region, prefix, and optional **endpoint URL** may appear in `config.json`. Access keys use the **standard AWS credential chain** (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, shared config/profile, instance role) and optional **`AWS_ENDPOINT_URL`** / **`AWS_REGION`**. The adapter must not log request bodies, authorization headers, or secret values.

2. **Conditional writes are real.** `put` maps `ifNoneMatch: "*"` → S3 **If-None-Match: \*** (create-only). `ifMatch` → **If-Match** with the stored ETag. Failed preconditions surface as **`PreconditionFailedError`** (HTTP 412), never silent overwrite.

3. **`crossDeviceCas` is probed, not assumed.** On **`init()`** (read/write opens only), the adapter runs a **sequential** private probe: create-only (`If-None-Match: *`), **duplicate create must 412**, matching `If-Match` replace, wrong `If-Match` must 412. Results are **cached per normalised `endpoint+bucket+prefix`** (lowercase host, default port, **`localhost` / `127.0.0.1` / `::1` → `loopback`**) for **24h** in **`~/.infinitecontext/storage-cas-probe-cache.json`**, with a sidecar **`storage-cas-probe-cache.json.last-good`** updated on every successful save. On **read**, **`expiresAtMs` is capped** at `probedAtMs + 24h`, and a stored **`bindingKey` mismatch** marks the record **untrusted / fail-closed**. Updates use a **`.lock` file** written atomically (**full JSON payload linked into place** with `pid`, `createdAtMs`, and `ownerToken`; never an empty lock), **locked read-modify-write** with **backoff sleep**, and **atomic** cache temp renames with **realpath** checks. Stale locks break only when metadata is readable, the pid is dead or age **> 60s**, and the **token is re-verified** before unlink; release unlinks only when **our token** still owns the lock. A successful **init probe never clears `cas_unsafe`** (only **`storage doctor`** may). **`cas_unsafe` from sequential probe failures** clears after **`storage doctor --recheck-cas`**. **`race_*` reasons** require **both** **`--recheck-cas`** and a passing **`--cas-race`** with doctor pass timestamps **after** the current **`unsafeAtMs`**; any **new** unsafe flag resets prior doctor passes. Corrupt/truncated cache files are **backed up** (forensics only), **salvaged from `.last-good`**, and a **`.corruption-marker`** keeps unknown backends **fail-closed** until each is individually rechecked; **`doctor --recheck-cas`** on one backend **does not drop** other backends’ records. **Read-only** `init()` **never creates** a missing bucket; it uses the cache or reports CAS **unknown**. **Read-only** CLI paths (`sync status`, `sync devices`, `sync parked list`) skip probing. **`storage doctor --recheck-cas`** and **`storage doctor --cas-race[=N]`** open a **probe session** adapter (conditional writes allowed only under **`ic-cas-probe/`** and **`ic-cas-race/`**). Only a **failed basic probe** or a **race double-win** persists **`cas_unsafe`**; other race outcomes are **inconclusive** (CAS off for that run only). Sweeps delete probe objects **older than 10 minutes**. **`crossDeviceCas`** is advertised only when cache/probe is good and **`cas_unsafe`** is clear.

4. **GC / compaction follow capability policy.** When **`crossDeviceCas`** is absent, **`storage-adapter-policy`** disables log GC and shared-manifest compaction (same as **`folder`**). Clients replay logs from **seq 0**; manifest coordination uses per-device contributions only when the merged-manifest path is selected by adapter policy.

5. **Shared manifest path.** S3 adapters with a successful CAS probe use the **CAS `manifest.json.enc`** path (`usesSharedStorageManifest` / `loadStorageManifest`), not folder merge, so **`manifest_generation`** and **`crossDeviceCas`** RMW behave like **`local-filesystem`**.

6. **List consistency.** `list` uses `ListObjectsV2` under `prefix + logicalKey`. Pagination honors `limit` and `cursor` (S3 continuation / start-after). Returned **`etag`** and **`size`** come from S3 object metadata.

7. **Binding key.** `storageBindingKey` for sync state high-water is **`s3:<bucket>:<prefix>`** (bucket and prefix normalized, no trailing slash on prefix; no secrets), via `resolveObjectStoreSyncBindingKey` when `storage.backend=s3`.

## Configuration

| Source | Field |
|--------|--------|
| `config.json` → `storage.backend` | `"s3"` |
| `config.json` → `storage.s3.bucket` | Bucket name (required) |
| `config.json` → `storage.s3.prefix` | Key prefix (optional, default `infinitecontext`) |
| `config.json` → `storage.s3.region` | Region hint (optional if `AWS_REGION` set) |
| `config.json` → `storage.s3.endpoint` | Custom base URL (optional; prefer `AWS_ENDPOINT_URL`) |
| Env | `AWS_*`, `AWS_ENDPOINT_URL`, `INFINITECONTEXT_S3_BUCKET`, `INFINITECONTEXT_S3_PREFIX` |

## CI

**`storage.yml`** builds a **pinned MinIO server from source** (`git clone --branch RELEASE.2024-11-07T00-52-20Z` + `go build` — GitHub/dl.min.io release binaries return **410** in CI). The server listens on port **9000**. When `IC_REQUIRE_MINIO=1`, tests require `AWS_ENDPOINT_URL` + the CI test bucket env. S3 **`init()`** uses the **cached basic CAS probe** only (no per-init race). **`storage-doctor-cas-minio.test.mjs`** runs **`doctor --recheck-cas`** and **`doctor --cas-race`** against MinIO. Tests skip locally without MinIO.

## Related docs

- `docs/design/storage-filesystem-adapter.md` — object file shape and CAS semantics mirrored on S3
- `docs/design/storage-secret-store.md` — future optional storage of non-AWS secrets (S3 uses env chain in #10)
- `docs/design/storage-layout.md` — layout paths and manifest policy
