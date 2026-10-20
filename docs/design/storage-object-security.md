# Pluggable storage objects (Phase 4.5)

## Guarantee (client)

**Production puts** go through `ObjectStoreSyncTransport.putObject`, which accepts only bodies **sealed** by `encryptVaultPlaintextForStoragePut` (DEK + JSON-serializable plaintext → vault AEAD envelope + storage wrapper).

The seal is an in-process digest bound to the exact `Uint8Array` returned from that helper — not wire metadata. Adapters still validate the **storage object shape** (`ic_storage_v`, key-bound `aad`, strict `enc` envelope, minimum XC20P `ct` length), but **cannot prove** that `enc.ct` decrypts to non-plaintext without the DEK.

## What this protects (and what it does not)

This protects against **accidental misuse** (calling `putObject` with hand-built bytes, wrong helper, or stale buffers). It does **not** stop **deliberate exfiltration by in-process code** that can:

- Call `StorageAdapter.put` directly if the process holds a reference to an adapter instance.
- Import non-public modules (for example contract-test helpers or deep paths) in a compromised or malicious bundle.
- Build valid-looking storage JSON and write it through any path that bypasses `ObjectStoreSyncTransport`.

**Mitigations in this PR:** only `encryptVaultPlaintextForStoragePut` seals bodies; bypass helpers are not public; post-seal byte mutation is detected via digest re-check; `putObject` verifies the seal then stores a **copy** so caller-held buffers cannot mutate backing storage; `ObjectStoreSyncTransport` keeps its adapter in a private field; all-zero / wrong-length DEKs are rejected at encrypt time.

**Limits:** there is a small **timing gap** between digest verification and `adapter.put` — another thread in the same process could still race or bypass via direct adapter access. The seal does not audit **weak or test DEKs** (for example repeated-byte keys) if they are 32 non-zero bytes; production callers must supply vault-managed DEKs.

**Remaining risk (accepted):** without decrypting, adapter shape checks cannot detect arbitrary bytes in `enc.ct` ≥ 16 bytes. Hosted/API paths require vault envelopes; sync object store reduces accidental plaintext via the sealed vault encrypt path.

Future work: optional decrypt-and-policy check in the vault layer before seal, or content-addressed blobs with DEK-side plaintext hash in AAD.

## Residual metadata (Phase 4.5 note)

Cleartext **AAD** fields and object **key paths** can reveal the chosen layout prefix (for example `accounts/.../ic-v1/...`). Device and manifest objects are not padded to a fixed size, so object counts and growth can be inferred from blob sizes on the remote; log segments use padding (see layout design). Treat this as an accepted metadata leak in the current threat model unless you hash prefixes in AAD or pad small objects.

## Node.js version

The JS SDK storage stack requires **Node ≥ 22.12**. Older runtimes may fail early in the test suite without a clear message unless you use `npm run premerge`, which prints an explicit version preflight.

## CI

GitHub Actions workflow **`ci.yml`** on pull requests and `main`:

1. **`check`** — `pnpm -r check` (including `CI=true` builds such as `apps/mcp-server`).
2. **`test`** — runs after `check` succeeds; Postgres **17** service container, schema migrate, then serial `pnpm -r test --workspace-concurrency=1`.

From `apps/js-sdk`, **`npm run premerge`** (with optional `STORAGE_EMU=1` after `storage:emu:up`) runs the #12 path guard, syntax checks, and storage tests including `tests/storage/*.test.mjs`.
