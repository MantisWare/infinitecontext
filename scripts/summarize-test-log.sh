#!/usr/bin/env bash
# Summarize node:test TAP footer lines from a pnpm -r test log.
log="${1:?usage: summarize-test-log.sh LOGFILE}"
echo "Package summaries (pass / fail / skipped):"
rg -o '^[^ ]+ test: # (pass|fail|skipped) [0-9]+' "$log" \
  | sed 's/ test: # / /' \
  | awk '
    { pkg=$1; kind=$2; n=$3; pass[pkg]+=(kind=="pass"?n:0); fail[pkg]+=(kind=="fail"?n:0); skip[pkg]+=(kind=="skipped"?n:0) }
    END {
      tp=0; tf=0; ts=0;
      for (p in pass) {
        printf "  %-22s pass=%4d fail=%2d skipped=%3d\n", p, pass[p], fail[p]+0, skip[p]+0;
        tp+=pass[p]; tf+=fail[p]+0; ts+=skip[p]+0;
      }
      printf "  %-22s pass=%4d fail=%2d skipped=%3d\n", "TOTAL (summed footers)", tp, tf, ts;
    }'

if rg -q 'ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL|Failed$' "$log"; then
  echo "Overall: FAILED (pnpm reported failure)"
  exit 1
fi
echo "Overall: PASSED"
