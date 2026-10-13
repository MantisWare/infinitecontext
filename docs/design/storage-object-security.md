# Pluggable storage objects (Phase 4.5)

## Guarantee (client)

**Production puts** go through `ObjectStoreSyncTransport.putObject`, which accepts only bodies **sealed** by:

- `encryptStorageObjectForPut` (caller supplies an already-encrypted envelope from vault crypto), or
- `encryptVaultPlaintextForStoragePut` (DEK + plaintext → envelope + storage wrapper).

The seal is a runtime `WeakSet` marker — not wire metadata. Adapters still validate the **storage object shape** (`ic_storage_v`, key-bound `aad`, strict `enc` envelope, minimum XC20P `ct` length), but **cannot prove** that `enc.ct` decrypts to non-plaintext without the DEK.

## Remaining risk (accepted)

Without decrypting, a malicious client could craft a storage JSON object whose `enc.ct` is ≥16 bytes of arbitrary bytes (including UTF-8 that looks like JSON). **Hosted/API paths** already require vault envelopes; **object store** mitigates exfiltration by requiring the encrypt helper + seal for sync transport puts.

Future work: optional decrypt-and-policy check in the vault layer before seal, or content-addressed blobs with DEK-side plaintext hash in AAD.

## CI

`storage.yml` runs storage adapter contract tests on every pull request (no issue #12 guard; #13 landed on `main`).
