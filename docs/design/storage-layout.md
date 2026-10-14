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

**Object keys** use **lowercase** `devH` path segments; crypto/AAD uses canonical uppercase Crockford `devH`. **No plaintext sync metadata** on remote storage — only sealed storage objects (including encrypted log segments).

**Local sync state** (vector cursor, trusted per-device `{seq,digest}` heads, ledger, conflicts, HLC clock) lives in **`~/.infinitecontext/object-store-sync-state.json`** (CLI) and **`daemon.db`** → `object_store_sync_state` (daemon). **`sync-cli-state.json` holds only the CLI pull cursor** — it must never embed object-store trust. Writes use **pid+random tmp**, **fsync+rename**, and a **`.lock` file** with `{ pid, hostname, createdAt, heartbeatAt }`: acquire retries ~10s with jitter; stale locks break when the pid is dead on the same host or heartbeat age exceeds **60s**. Saves merge under lock (max trusted heads + digest check, union ledger/conflicts). Corrupt state fails closed (`ObjectStoreSyncStateError`). After a segment is written, state save is **best-effort retried**; a failed save is recovered on the next run via remote `client_id` reconcile.

**Merge / replica (object store clients):** mutations carry an **HLC** `{ wall_ms, counter }` with **`devH` from the segment path**. Pull emits `hlc`; `applySyncChangeToReplica` applies **LWW by HLC** for appends/updates. **`message_delete` wins permanently** — it sets a **tombstone**; later updates/appends to that message are ignored and emit deterministic **`tombstone_blocked_update`** / **`lww_superseded`** conflicts preserving the losing payload (differs from hosted server, which rejects stale deletes). Remote segment HLC **> now + 5min** is not applied: pull returns **`clock_skew`** for that `devH`, cursor stays put, retry later. Local HLC clock still caps at **now + 5min**.

**Delete stale-base (object store transport):** `message_delete` requires explicit **`base_vector`** (snapshot at plan time, carried through the outbox). Push checks stale against **`base_vector` only** (not the live cursor). A device missing from `base_vector` is treated as **base seq 0**. Conflicts are deterministic (`delete_stale_base:…`).

**Owner push:** before every push, re-verify the trusted anchor and prefix; fail closed on rollback/fork. Pull checks cached tip + `prev_digest` link; optionally re-verifies the full chain below trust on startup and every **32** pulls.

**vault.json:** `ic_vault_v`, `kdf_salt_b64` (16 bytes, same role as server `kdf_salt`), strict **`kdf`** (argon2id with minimum memory/iterations matching hosted vault), `wrapped_dek_b64` (wrapped DEK record with no extra JSON fields).

Implementation: `apps/js-sdk/lib/storage/layout.mjs`. Deterministic test vectors and tamper/rename/reorder tests: `apps/js-sdk/tests/storage/layout.test.mjs`. Fixed-nonce encryption is **test-only** (`apps/js-sdk/tests/helpers/layout-test-crypto.mjs`, not exported from `storage/index.mjs`). Vault unlock uses **`deriveVaultKekWithParams`** with the **`kdf`** block recorded in `vault.json` (bounded memory/iterations).
