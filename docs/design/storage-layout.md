# Object layout + naming crypto (Phase 4.5)

On-disk tree under `<prefix>/ic-v1/`:

| Relative path | Role |
|---------------|------|
| `vault.json` | Cleartext **version + KDF params + KDF salt**; wrapped DEK as base64 (`wrapDek` / strict parse) |
| `manifest.json.enc` | Encrypted manifest blob (AEAD) |
| `devices/<devH>.json.enc` | Per-device metadata |
| `log/<devH>/<seq:012d>.enc` | Append-only log segments |
| `snap/<epoch:08d>.enc` | Snapshots |
| `lock/<name>.lock` | Coarse locks |

**Naming:** `namingKey = HKDF-SHA256(DEK, info="ic-storage-names-v1")`; `devH = Crockford-base32(HMAC-SHA256(namingKey, canonical_lowercase_device_uuid)[0:16])`. **`devH`** must match `^[0-9A-HJKMNP-TV-Z]{26}$` in paths and AAD.

**Log segments:** AEAD envelope of JSON `{ dev, seq, prev_digest, created_at, mutations }` (no extra fields). **`prev_digest`** is empty at `seq === 0`; otherwise a **64-character lowercase hex** sha256 of the previous segment envelope. **AAD** = `ic-storage|v1|log|devH|seq` (versioned). Plaintext is **length-prefixed** (uint32 BE) JSON padded with zeros to one or more **4096-byte** buckets; padding tails must be all zero. **Decrypt** binds path **`seq`** and **`devH`** to the record (`deriveDevH(dek, dev)`). **Chain verify** requires an anchored **`expectedHead` `{ seq, digest }` from trusted, monotonic local state** (the last verified tip for that `devH`), contiguous segments `0..seq`, and matching **`prev_digest`** links (rejects truncation, rollback, gaps, forks). **Trust-on-first-use:** a device with no local trusted head for a remote `devH` accepts the first verified chain tip it sees; afterwards the trusted head only moves forward — a lower seq or digest mismatch at a known seq is a rollback/fork error (fail closed, never silently accept).

**Object keys** use **lowercase** `devH` path segments; crypto/AAD uses canonical uppercase Crockford `devH`. **No plaintext sync metadata** on remote storage — only sealed storage objects (including encrypted log segments). Local sync state (vector cursor, trusted per-device `{seq,digest}` heads, own next seq, HLC clock) lives only in **`sync-cli-state.json`** (CLI, atomic tmp+fsync+rename with file lock) and **`daemon.db`** (`object_store_sync_state`, transactional merge). Corrupt state fails closed (`ObjectStoreSyncStateError`).

**Merge / replica:** mutations carry an **HLC** `{ wall_ms, counter, devH }` where **`devH` comes from the segment path**, never from mutation JSON. Pull emits changes with `hlc`; consumers apply **LWW by HLC** (`applySyncChangeToReplica`). Remote HLC may advance local clock up to **now + 5 minutes** (ordering only). **`message_delete`** stale-base conflicts use the **vector cursor at plan time** (optional `base_vector` on the mutation): a delete conflicts if a target message has `message_append`/`message_update` from `(devH, seq)` with `seq > base[devH]` (missing devH → `-1`). Conflicts are deterministic (`delete_stale_base:…`); deletes are never resolved by LWW.

**Owner push:** before every push, the device re-verifies its **trusted anchor** segment exists with matching digest and that the prefix through that seq is intact; missing or mismatched tips → rollback/fork (fail closed, no write). Pull verifies cached trusted anchors, then validates **only new segments** after the cached `(seq, digest)` per `devH`.

**vault.json:** `ic_vault_v`, `kdf_salt_b64` (16 bytes, same role as server `kdf_salt`), strict **`kdf`** (argon2id with minimum memory/iterations matching hosted vault), `wrapped_dek_b64` (wrapped DEK record with no extra JSON fields).

Implementation: `apps/js-sdk/lib/storage/layout.mjs`. Deterministic test vectors and tamper/rename/reorder tests: `apps/js-sdk/tests/storage/layout.test.mjs`. Fixed-nonce encryption is **test-only** (`apps/js-sdk/tests/helpers/layout-test-crypto.mjs`, not exported from `storage/index.mjs`). Vault unlock uses **`deriveVaultKekWithParams`** with the **`kdf`** block recorded in `vault.json` (bounded memory/iterations).
