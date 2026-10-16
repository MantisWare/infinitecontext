# S3 / S3-compatible object store (Phase 4.5 #10)

Remote ciphertext object storage using the **`StorageAdapter`** contract over **S3 API** (AWS S3, MinIO, Cloudflare R2, Backblaze B2, Wasabi, etc.). Logical object keys match the filesystem adapter grammar (`accounts/.../ic-v1/...`); bytes on wire are the same sealed storage JSON as local/folder backends.

## Invariants

1. **Credentials never in config or logs.** Bucket, region, prefix, and optional **endpoint URL** may appear in `config.json`. Access keys use the **standard AWS credential chain** (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, shared config/profile, instance role) and optional **`AWS_ENDPOINT_URL`** / **`AWS_REGION`**. The adapter must not log request bodies, authorization headers, or secret values.

2. **Conditional writes are real.** `put` maps `ifNoneMatch: "*"` → S3 **If-None-Match: \*** (create-only). `ifMatch` → **If-Match** with the stored ETag. Failed preconditions surface as **`PreconditionFailedError`** (HTTP 412), never silent overwrite.

3. **`crossDeviceCas` is probed, not assumed.** On **`init()`** (read/write opens only), the adapter runs a **sequential** private probe: create-only (`If-None-Match: *`), **duplicate create must 412**, matching `If-Match` replace, wrong `If-Match` must 412. Results are **cached per `endpoint+bucket+prefix`** for **24h** in **`~/.infinitecontext/storage-cas-probe-cache.json`**. **Read-only** CLI paths (`sync status`, `sync devices`, `sync parked list`) **skip** probing and use the cache (or report CAS **unknown** / off when uncached). A failed probe sets a sticky **`cas_unsafe`** flag for that binding until **`storage doctor --recheck-cas`** succeeds. Optional stress testing: **`storage doctor --cas-race[=N]`** (default **20** rounds) runs parallel **If-None-Match** creates and **If-Match** replaces with **different bodies**; a double-win marks **`cas_unsafe`**. **`crossDeviceCas`** and conditional capabilities are advertised **only** when the cached/probed basic test passes and **`cas_unsafe`** is clear. Probe objects under **`ic-cas-probe/`** and **`ic-cas-race/`** are deleted in a **`finally`** and swept before the next probe / **`storage doctor --repair`**.

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

**`storage.yml`** builds a **pinned MinIO server from source** (`git clone --branch RELEASE.2024-11-07T00-52-20Z` + `go build` — GitHub/dl.min.io release binaries return **410** in CI). The server listens on port **9000**. When `IC_REQUIRE_MINIO=1`, tests require `AWS_ENDPOINT_URL` + the CI test bucket env. S3 **`init()`** uses the **cached basic CAS probe** only (no per-init race). Tests skip locally without MinIO.

## Related docs

- `docs/design/storage-filesystem-adapter.md` — object file shape and CAS semantics mirrored on S3
- `docs/design/storage-secret-store.md` — future optional storage of non-AWS secrets (S3 uses env chain in #10)
- `docs/design/storage-layout.md` — layout paths and manifest policy
