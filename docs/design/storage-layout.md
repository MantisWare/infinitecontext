# Object layout + naming crypto (Phase 4.5)

On-disk tree under `<prefix>/ic-v1/`:

| Relative path | Role |
|---------------|------|
| `vault.json` | Cleartext **version + KDF params** only; wrapped DEK as base64 (`wrapDek` / `parseWrappedDekRecord`) |
| `manifest.json.enc` | Encrypted manifest blob (AEAD) |
| `devices/<devH>.json.enc` | Per-device metadata |
| `log/<devH>/<seq:012d>.enc` | Append-only log segments |
| `snap/<epoch:08d>.enc` | Snapshots |
| `lock/<name>.lock` | Coarse locks |

**Naming:** `namingKey = HKDF-SHA256(DEK, info="ic-storage-names-v1")`; `devH = Crockford-base32(HMAC-SHA256(namingKey, device_uuid)[0:16])`.

**Log segments:** AEAD envelope of JSON `{ dev, seq, prev_digest, created_at, mutations }` with `AAD = ic-storage|log|devH|seq`, plaintext padded to **4096 bytes** before encrypt. Chain verification uses `prev_digest = sha256(canonical envelope JSON)` of the previous segment.

Implementation: `apps/js-sdk/lib/storage/layout.mjs`.
