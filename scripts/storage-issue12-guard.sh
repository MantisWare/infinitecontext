#!/usr/bin/env bash
set -euo pipefail

# Phase 4.5 storage PRs must not overlap issue #12 (lost-update / CAS fixes).
BASE="${STORAGE_GUARD_BASE:-origin/main}"
if ! git rev-parse --verify "$BASE" >/dev/null 2>&1; then
  BASE="main"
fi

mapfile -t CHANGED < <(git diff --name-only "$BASE"...HEAD)

GUARD_PATHS=(
  "apps/api/src/routes/contexts.ts"
  "apps/api/src/routes/sync.ts"
  "packages/core/src/ops/update-messages.ts"
)

violations=()
for file in "${CHANGED[@]}"; do
  for guard in "${GUARD_PATHS[@]}"; do
    if [[ "$file" == "$guard" ]]; then
      violations+=("$file")
    fi
  done
  if [[ "$file" == apps/api/src/sync/* ]]; then
    violations+=("$file")
  fi
done

if ((${#violations[@]} > 0)); then
  echo "storage.yml guard: this PR touches issue #12 files (not allowed in Phase 4.5 storage PRs):"
  printf '  - %s\n' "${violations[@]}"
  exit 1
fi

echo "storage.yml guard: OK (no issue #12 paths in diff vs ${BASE})"
