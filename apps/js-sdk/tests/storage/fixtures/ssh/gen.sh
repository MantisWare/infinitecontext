#!/usr/bin/env bash
set -euo pipefail

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
