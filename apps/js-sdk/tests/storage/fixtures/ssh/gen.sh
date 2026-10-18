#!/usr/bin/env bash
set -euo pipefail

if ! command -v ssh-keygen >/dev/null 2>&1; then
  echo "storage:emu requires openssh-client (ssh-keygen). Install it (e.g. apt install openssh-client)." >&2
  exit 1
fi

here="$(cd "$(dirname "$0")" && pwd)"
out="${here}/generated"
mkdir -p "$out"
chmod 700 "$out"

if [[ ! -f "${out}/id_ed25519" ]]; then
  ssh-keygen -t ed25519 -f "${out}/id_ed25519" -N "" -C "infinitecontext-storage-emu-test-only"
fi

chmod 600 "${out}/id_ed25519" 2>/dev/null || true
chmod 644 "${out}/id_ed25519.pub" 2>/dev/null || true

echo "storage emu: test SSH keys ready under ${out}/ (gitignored, test-only)"
