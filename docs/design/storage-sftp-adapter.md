# SFTP object store (Phase 4.5 #11)

Remote ciphertext object storage over **SFTP** (OpenSSH `sftp-server`, `atmoz/sftp`, NAS appliances, etc.). Logical keys match the filesystem adapter grammar (`accounts/.../ic-v1/...`); bytes on the wire are the same sealed storage JSON as local/folder/S3 backends.

## Setup

1. Choose auth: **SSH key file** (recommended), **SSH agent** (`SSH_AUTH_SOCK` or `storage.sftp.agent=true`), or **password** (`storage.sftp.auth=password` with secret in the secret store only).
2. Pin the host key (no trust-on-first-use):

```bash
ssh-keyscan -p 2222 your.host.example | ssh-keygen -lf -
infinitecontext config set storage.sftp.hostKeySha256 SHA256:…
```

3. Set backend and connection fields (`config set storage.backend sftp`, `storage.sftp.host`, `storage.sftp.port`, `storage.sftp.username`, `storage.sftp.root`).

### atmoz/sftp (local emulator / Fix PR compose)

The `atmoz/sftp` image creates user home with a **writable chroot subdirectory** named `upload`. Object keys live under that directory (not the session `/` home). Set:

```bash
infinitecontext config set storage.sftp.root upload
```

Do **not** use `/upload` or `.` — paths are relative to the SFTP session root (`/home/<user>/`), and only `upload/` is writable. Tests and `IC_SFTP_TEST_ROOT` default to `upload`.

Password and key passphrases: `infinitecontext config set storage.sftp.password` (prompted; never pass on argv). Stored under `storage.sftp.password` / `storage.sftp.keyPassphrase` in `lib/storage/secret-store.mjs`, not in `config.json`.

## Configuration

| Key | Purpose |
|-----|---------|
| `storage.backend` | `"sftp"` |
| `storage.sftp.host` | Hostname or IP (required) |
| `storage.sftp.port` | TCP port (default 22) |
| `storage.sftp.username` | SFTP user (required) |
| `storage.sftp.root` | Remote directory prefix for `ic-v1/` layout (required; **`upload`** on `atmoz/sftp`) |
| `storage.sftp.auth` | `key` \| `agent` \| `password` |
| `storage.sftp.privateKeyPath` | Path to private key (key auth) |
| `storage.sftp.knownHostsPath` | Default `~/.ssh/known_hosts` when `hostKeySha256` unset |
| `storage.sftp.hostKeySha256` | OpenSSH `SHA256:…` pin (recommended) |
| `storage.sftp.agent` | Prefer agent when true |
| `storage.sftp.timeoutMs` | Connect timeout (default 20000) |
| `storage.sftp.lockTtlMs` | Lease TTL hint (default 60000) |
| `storage.sftp.leaseSkewMs` | Break stale locks only after `expiresAt + skew` (default 30000) |

## Capabilities (live probe)

| Flag | SFTP |
|------|------|
| `createExclusive` | yes (`ifNoneMatch: "*"`) |
| `conditionalOverwrite` (CAS) | **no** — use lease locks |
| `atomicRename` | yes when `posix-rename@openssh.com` present |
| `createOnlyRename` | fallback when posix-rename missing |
| `listConsistency` | strong |
| `crossDeviceCas` | **no** |
| `locking` | lease (`lease-lock.mjs`) |

`config doctor` runs TCP/auth/root/create-excl/posix-rename/temp checks and prints fixes.

## Atomicity without posix-rename

When `posix-rename@openssh.com` is missing (some Windows OpenSSH / NAS builds):

- **Create-only** (`ifNoneMatch: "*"`) remains atomic (exclusive open or rename-if-absent).
- **Unconditional overwrite** of shared objects is **refused** at the adapter; writers must hold the **lease lock**.
- Overwrites under lease are **not atomic**: a crash can leave the previous object plus a stale `.ic-tmp-*.part` (swept on init after lease TTL).

## Zero-knowledge

Only **ciphertext** storage objects leave the device. SFTP credentials (password, passphrase) live in the secret store; private key **contents** are never copied into config.

## Limits

- No `ifMatch` / cross-device CAS (manifest updates use lease + RMW fallbacks).
- Windows OpenSSH SFTP server: **untested**; expect missing posix-rename.
- Optional npm dep `ssh2-sftp-client` (Apache-2.0); `ssh2` native `cpu-features` is optional and never required.

## Related

- `docs/design/storage-layout.md` — layout paths and lease semantics
- `docs/design/storage-secret-store.md` — password/passphrase storage
- `docs/design/storage-s3-adapter.md` — CAS-capable remote backend contrast
