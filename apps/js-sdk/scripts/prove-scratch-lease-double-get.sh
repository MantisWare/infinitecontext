#!/usr/bin/env bash
# Scratch proof: patched 77db470 double-get + stale-head storage yields 2 holders; fixed code does not.
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
lease="$repo_root/apps/js-sdk/lib/storage/lease-lock.mjs"
bak="$(mktemp)"
cp "$lease" "$bak"
cleanup() { cp "$bak" "$lease"; rm -f "$bak"; }
trap cleanup EXIT

python3 - "$lease" <<'PY'
import sys
from pathlib import Path
p = Path(sys.argv[1])
text = p.read_text()
old = """  if (existing && isLeaseLockStale(existing, now) && row?.etag) {
    try {
      await options.adapter.delete(key, { ifMatch: row.etag });
    } catch {
      /* best-effort break stale */
    }
  }"""
new = """  if (existing && isLeaseLockStale(existing, now)) {
    let etagForDelete = row?.etag;
    const row2 = await readLeaseObject(options.adapter, options.dek, options.layoutPrefix, lockName);
    etagForDelete = row2?.etag ?? etagForDelete;
    if (etagForDelete) {
      try {
        await options.adapter.delete(key, { ifMatch: etagForDelete });
      } catch {
        /* best-effort break stale */
      }
    }
  }"""
if old not in text:
    raise SystemExit("lease-lock patch block not found")
p.write_text(text.replace(old, new, 1))
PY

echo "=== Fixed lease-lock + honest memory (before patch restore): N/A — already patched ==="
echo "=== Scratch double-get + stale-head adapter (expect 2 holders) ==="
IC_LEASE_SCRATCH_PROOF=1 node --import "$repo_root/scripts/ic-test-tmp-preload.mjs" --test "$repo_root/apps/js-sdk/tests/storage/lease-lock-scratch-proof.test.mjs" 2>&1 | tee /tmp/scratch-revert-proof.txt | tail -15

echo ""
echo "=== Main race test under double-get patch + honest memory (expect subtest FAIL if 2 holders) ==="
if node --import "$repo_root/scripts/ic-test-tmp-preload.mjs" --test "$repo_root/apps/js-sdk/tests/storage/lease-lock-owner.test.mjs" 2>&1 | rg -q "not ok 2 - forced stale-break"; then
  echo "OK: race regression test failed under double-get patch (2 holders)"
else
  echo "NOTE: honest memory keeps single holder under double-get-only patch (77db470 CAS-safe); stale-head proof above shows failure mode"
fi
