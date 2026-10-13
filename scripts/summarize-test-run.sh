#!/usr/bin/env bash
# Usage: summarize-test-run.sh /tmp/test-run-1.log
log="$1"
echo "=== Summary for $(basename "$log") ==="
rg '# (pass|fail|skipped|tests) ' "$log" | awk '
  /# tests / { gsub(/.*# tests /,""); tests+=$1 }
  /# pass / { gsub(/.*# pass /,""); pass+=$1 }
  /# fail / { gsub(/.*# fail /,""); fail+=$1 }
  /# skipped / { gsub(/.*# skipped /,""); skipped+=$1 }
  END { printf "totals: tests=%s pass=%s fail=%s skipped=%s\n", tests+0, pass+0, fail+0, skipped+0 }
'
rg 'skipped:|t\.skip|postgresReady|skipped:' "$log" | head -20 || true
rg 'ERR_PNPM_RECURSIVE|Failed$' "$log" || echo "no package failures"
