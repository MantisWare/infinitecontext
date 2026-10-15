# S3 / S3-compatible object store (Phase 4.5 #10)

Remote ciphertext object storage using the **`StorageAdapter`** contract over **S3 API** (AWS S3, MinIO, Cloudflare R2, Backblaze B2, Wasabi, etc.). Logical object keys match the filesystem adapter grammar (`accounts/.../ic-v1/...`); bytes on wire are the same sealed storage JSON as local/folder backends.

## Invariants

1. **Credentials never in config or logs.** Bucket, region, prefix, and optional **endpoint URL** may appear in `config.json`. Access keys use the **standard AWS credential chain** (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, shared config/profile, instance role) and optional **`AWS_ENDPOINT_URL`** / **`AWS_REGION`**. The adapter must not log request bodies, authorization headers, or secret values.

2. **Conditional writes are real.** `put` maps `ifNoneMatch: "*"` → S3 **If-None-Match: \*** (create-only). `ifMatch` → **If-Match** with the stored ETag. Failed preconditions surface as **`PreconditionFailedError`** (HTTP 412), never silent overwrite.

3. **`crossDeviceCas` is probed, not assumed.** On `init()`, the adapter runs a private probe object (create-only, then matching `If-Match`, then wrong `If-Match` must 412). **`crossDeviceCas`** is advertised **only** when the probe succeeds. If the endpoint ignores preconditions, the adapter still supports get/put/list/delete but **must not** advertise **`crossDeviceCas`**.

4. **GC / compaction follow capability policy.** When **`crossDeviceCas`** is absent, **`storage-adapter-policy`** disables log GC and shared-manifest compaction (same as **`folder`**). Clients replay logs from **seq 0**; manifest coordination uses per-device contributions only when the merged-manifest path is selected by adapter policy.

5. **Shared manifest path.** S3 adapters with a successful CAS probe use the **CAS `manifest.json.enc`** path (`usesSharedStorageManifest` / `loadStorageManifest`), not folder merge, so **`manifest_generation`** and **`crossDeviceCas`** RMW behave like **`local-filesystem`**.

6. **List consistency.** `list` uses `ListObjectsV2` under `prefix + logicalKey`. Pagination honors `limit` and `cursor` (S3 continuation / start-after). Returned **`etag`** and **`size`** come from S3 object metadata.

7. **Binding key.** `storageBindingKey` for sync state high-water is `s3:<bucket>:<prefix>` (normalized, no secrets), via `resolveObjectStoreSyncBindingKey`.

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

**`storage.yml`** runs contract tests against **MinIO** when the service is available (`AWS_ENDPOINT_URL` + test bucket env). Tests skip locally without MinIO.

## Related docs

- `docs/design/storage-filesystem-adapter.md` — object file shape and CAS semantics mirrored on S3
- `docs/design/storage-secret-store.md` — future optional storage of non-AWS secrets (S3 uses env chain in #10)
- `docs/design/storage-layout.md` — layout paths and manifest policy
