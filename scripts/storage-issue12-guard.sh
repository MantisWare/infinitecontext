#!/usr/bin/env bash
set -euo pipefail

BASE="${STORAGE_GUARD_BASE:-origin/main}"
if ! git rev-parse --verify "$BASE" >/dev/null 2>&1; then
  BASE="main"
fi

# Never bypassable (workflow/guard tamper protection).
INFRA_GUARD_PATHS=(
  ".github/workflows/storage.yml"
  "scripts/storage-issue12-guard.sh"
)

# Issue #12 + #13 overlap paths (allow-12-paths may skip only this set).
ISSUE12_GUARD_PATHS=(
  "apps/api/src/routes/contexts.ts"
  "apps/api/src/routes/sync.ts"
  "packages/core/src/ops/update-messages.ts"
  "apps/js-sdk/lib/encrypted-client.mjs"
  "packages/storage/src/sync/drizzle-sync-repository.ts"
  "packages/core/src/sync/sync-service.ts"
  "packages/storage/src/drizzle.ts"
  "packages/core/src/root-context-lock.ts"
)

ISSUE12_GUARD_PREFIXES=(
  "apps/api/src/sync/"
)

SKIP_ISSUE12="${ALLOW_ISSUE12_PATHS:-0}"
if [[ "$SKIP_ISSUE12" == "1" ]]; then
  echo "storage.yml guard: ALLOW_ISSUE12_PATHS=1 — skipping issue #12/#13 path enforcement only."
fi

is_issue12_path() {
  local path="$1"
  for guard in "${ISSUE12_GUARD_PATHS[@]}"; do
    if [[ "$path" == "$guard" ]]; then
      return 0
    fi
  done
  for prefix in "${ISSUE12_GUARD_PREFIXES[@]}"; do
    if [[ "$path" == "$prefix"* ]]; then
      return 0
    fi
  done
  return 1
}

is_infra_path() {
  local path="$1"
  for guard in "${INFRA_GUARD_PATHS[@]}"; do
    if [[ "$path" == "$guard" ]]; then
      return 0
    fi
  done
  return 1
}

is_guarded_path() {
  local path="$1"
  if is_infra_path "$path"; then
    return 0
  fi
  if [[ "$SKIP_ISSUE12" == "1" ]]; then
    return 1
  fi
  is_issue12_path "$path"
}

violations=()

while IFS=$'\t' read -r status path_a path_b; do
  [[ -z "${status:-}" ]] && continue
  case "$status" in
    R*|C*)
      old="$path_a"
      new="$path_b"
      if is_guarded_path "$old"; then
        violations+=("rename/copy from guarded path: $old -> $new")
      fi
      if is_guarded_path "$new"; then
        violations+=("$new")
      fi
      ;;
    *)
      if is_guarded_path "$path_a"; then
        violations+=("$path_a")
      fi
      ;;
  esac
done < <(git diff --name-status -M -C30 "$BASE"...HEAD)

while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  if ! git cat-file -e "HEAD:$path" 2>/dev/null; then
    continue
  fi
  mode=$(git ls-tree HEAD "$path" | awk '{print $1}')
  if [[ "$mode" == "120000" ]]; then
    target=$(git show "HEAD:$path" | tr -d '\n')
    for guard in "${ISSUE12_GUARD_PATHS[@]}" "${INFRA_GUARD_PATHS[@]}"; do
      if [[ "$target" == "$guard" || "$target" == *"/$guard" || "$target" == *"$guard" ]]; then
        violations+=("symlink to guarded path: $path -> $target")
      fi
    done
    if [[ "$target" == ../* || "$target" == */../* ]]; then
      violations+=("relative symlink: $path -> $target")
    fi
  fi
done < <(git diff --name-only "$BASE"...HEAD)

guard_list_files() {
  printf '%s\n' "${INFRA_GUARD_PATHS[@]}"
  if [[ "$SKIP_ISSUE12" != "1" ]]; then
    printf '%s\n' "${ISSUE12_GUARD_PATHS[@]}"
    git ls-tree -r --name-only "$BASE" apps/api/src/sync/ 2>/dev/null || true
  fi
}

while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  git cat-file -e "HEAD:$path" 2>/dev/null || continue
  while IFS= read -r guarded; do
    [[ -z "$guarded" ]] && continue
    git cat-file -e "$BASE:$guarded" 2>/dev/null || continue
    if git diff --quiet "$BASE:$guarded" "HEAD:$path" 2>/dev/null; then
      violations+=("added/modified file matches guarded content: $path (copy of $guarded)")
      continue
    fi
    base_lines=$(git show "$BASE:$guarded" | wc -l | tr -d ' ')
    if [[ "$base_lines" == "0" ]]; then
      continue
    fi
    common=$(
      comm -12 \
        <(git show "$BASE:$guarded" | sort -u) \
        <(git show "HEAD:$path" | sort -u) | wc -l | tr -d ' '
    )
    threshold=$((base_lines * 25 / 100))
    if (( common > threshold )); then
      violations+=("partial/near copy (>=25% shared lines): $path ~ $guarded")
    fi
  done < <(guard_list_files)
done < <(git diff --name-only --diff-filter=AM "$BASE"...HEAD)

if ((${#violations[@]} > 0)); then
  mapfile -t unique < <(printf '%s\n' "${violations[@]}" | sort -u)
  echo "storage.yml guard: blocked guarded-path overlap (diff vs ${BASE}):"
  printf '  - %s\n' "${unique[@]}"
  echo "Label allow-12-paths (maintainer-approved) skips issue #12/#13 paths only."
  exit 1
fi

echo "storage.yml guard: OK (no blocked paths in diff vs ${BASE})"
