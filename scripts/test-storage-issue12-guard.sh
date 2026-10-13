#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GUARD="$ROOT/scripts/storage-issue12-guard.sh"

REPO=""

run_guard() {
  local base="$1"
  local label="$2"
  set +e
  local out
  out=$(cd "$REPO" && ALLOW_ISSUE12_PATHS="${ALLOW_ISSUE12_PATHS:-}" STORAGE_GUARD_BASE="$base" bash "$GUARD" 2>&1)
  local code=$?
  set -e
  if [[ "$label" == expect-fail ]]; then
    if [[ $code -eq 0 ]]; then
      echo "expected guard failure but passed: $out"
      exit 1
    fi
    return 0
  fi
  if [[ $code -ne 0 ]]; then
    echo "$out"
    exit 1
  fi
}

mk_repo() {
  local dir
  dir=$(mktemp -d)
  git -C "$dir" init -q
  git -C "$dir" config user.email "guard@test"
  git -C "$dir" config user.name "guard"
  mkdir -p "$dir/apps/api/src/routes" "$dir/apps/api/src/sync" "$dir/apps/js-sdk/lib" "$dir/packages/core/src/ops" "$dir/packages/core/src/sync" "$dir/packages/storage/src/sync" "$dir/.github/workflows" "$dir/scripts"
  cp "$GUARD" "$dir/scripts/storage-issue12-guard.sh"
  echo "name: Storage" > "$dir/.github/workflows/storage.yml"
  echo "// base" > "$dir/apps/api/src/routes/contexts.ts"
  echo "// sync route" > "$dir/apps/api/src/routes/sync.ts"
  echo "// update messages" > "$dir/packages/core/src/ops/update-messages.ts"
  echo "// sync hook" > "$dir/apps/api/src/sync/context-sync-hooks.ts"
  echo "// enc" > "$dir/apps/js-sdk/lib/encrypted-client.mjs"
  echo "// drizzle sync" > "$dir/packages/storage/src/sync/drizzle-sync-repository.ts"
  git -C "$dir" add -A
  git -C "$dir" commit -q -m "base"
  echo "$dir"
}

REPO=$(mk_repo)
BASE=$(git -C "$REPO" rev-parse HEAD)

run_guard "$BASE" expect-pass

echo "// edit" >> "$REPO/apps/api/src/routes/contexts.ts"
git -C "$REPO" add apps/api/src/routes/contexts.ts
git -C "$REPO" commit -q -m "edit contexts"
run_guard "$BASE" expect-fail
git -C "$REPO" reset --hard "$BASE" -q

git -C "$REPO" mv apps/api/src/routes/contexts.ts apps/api/src/routes/contexts2.ts
git -C "$REPO" commit -q -m "rename contexts"
run_guard "$BASE" expect-fail
git -C "$REPO" reset --hard "$BASE" -q

echo "// patch" >> "$REPO/apps/js-sdk/lib/encrypted-client.mjs"
git -C "$REPO" commit -am "edit encrypted client"
run_guard "$BASE" expect-fail
git -C "$REPO" reset --hard "$BASE" -q

echo "# tweak" >> "$REPO/scripts/storage-issue12-guard.sh"
git -C "$REPO" commit -am "edit guard"
run_guard "$BASE" expect-fail
git -C "$REPO" reset --hard "$BASE" -q

echo "jobs: {}" >> "$REPO/.github/workflows/storage.yml"
git -C "$REPO" commit -am "edit storage workflow"
run_guard "$BASE" expect-fail
git -C "$REPO" reset --hard "$BASE" -q

echo "// edit" >> "$REPO/apps/api/src/routes/contexts.ts"
git -C "$REPO" commit -am "edit with allow"
ALLOW_ISSUE12_PATHS=1 run_guard "$BASE" expect-pass
unset ALLOW_ISSUE12_PATHS

echo "# tweak" >> "$REPO/scripts/storage-issue12-guard.sh"
git -C "$REPO" commit -am "edit guard with allow label should still fail"
ALLOW_ISSUE12_PATHS=1 run_guard "$BASE" expect-fail

rm -rf "$REPO"
echo "storage-issue12-guard negative cases: OK"
