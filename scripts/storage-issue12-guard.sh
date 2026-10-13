#!/usr/bin/env bash
set -euo pipefail

# Phase 4.5 storage PRs must not overlap issue #12 (lost-update / CAS fixes).
if [[ "${ALLOW_ISSUE12_PATHS:-}" == "1" ]]; then
  echo "storage.yml guard: ALLOW_ISSUE12_PATHS=1 — skipping issue #12 path enforcement."
  exit 0
fi

BASE="${STORAGE_GUARD_BASE:-origin/main}"
if ! git rev-parse --verify "$BASE" >/dev/null 2>&1; then
  BASE="main"
fi

GUARD_PATHS=(
  "apps/api/src/routes/contexts.ts"
  "apps/api/src/routes/sync.ts"
  "packages/core/src/ops/update-messages.ts"
  "apps/js-sdk/lib/encrypted-client.mjs"
  "scripts/storage-issue12-guard.sh"
)

GUARD_PREFIXES=(
  "apps/api/src/sync/"
)

is_guarded_path() {
  local path="$1"
  for guard in "${GUARD_PATHS[@]}"; do
    if [[ "$path" == "$guard" ]]; then
      return 0
    fi
  done
  for prefix in "${GUARD_PREFIXES[@]}"; do
    if [[ "$path" == "$prefix"* ]]; then
      return 0
    fi
  done
  return 1
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
done < <(git diff --name-status -M -C50 "$BASE"...HEAD)

while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  if git cat-file -e "HEAD:$path" 2>/dev/null; then
    mode=$(git ls-tree HEAD "$path" | awk '{print $1}')
    if [[ "$mode" == "120000" ]]; then
      target=$(git show "HEAD:$path")
      for guard in "${GUARD_PATHS[@]}"; do
        if [[ "$target" == *"$guard"* ]] || [[ "$target" == "$guard" ]]; then
          violations+=("symlink to guarded path: $path -> $target")
        fi
      done
    fi
  fi
done < <(git diff --name-only "$BASE"...HEAD)

for path in $(git diff --name-only --diff-filter=A "$BASE"...HEAD); do
  for guard in "${GUARD_PATHS[@]}" "${GUARD_PREFIXES[@]}"*; do
    if [[ "$guard" == *"*"* ]]; then continue; fi
    if git cat-file -e "$BASE:$guard" 2>/dev/null && git cat-file -e "HEAD:$path" 2>/dev/null; then
      if git diff --quiet "$BASE:$guard" "HEAD:$path"; then
        violations+=("added file matches guarded content: $path (copy of $guard)")
      fi
    fi
  done
  for prefix in "${GUARD_PREFIXES[@]}"; do
    while IFS= read -r guarded; do
      [[ -z "$guarded" ]] && continue
      if git cat-file -e "$BASE:$guarded" 2>/dev/null && git diff --quiet "$BASE:$guarded" "HEAD:$path" 2>/dev/null; then
        violations+=("added file matches guarded sync content: $path (copy of $guarded)")
      fi
    done < <(git ls-tree -r --name-only "$BASE" "$prefix" 2>/dev/null || true)
  done
done

if ((${#violations[@]} > 0)); then
  # de-dupe
  mapfile -t unique < <(printf '%s\n' "${violations[@]}" | sort -u)
  echo "storage.yml guard: this PR touches issue #12 paths (not allowed in Phase 4.5 storage PRs):"
  printf '  - %s\n' "${unique[@]}"
  echo "Add label allow-12-paths to bypass when intentional."
  exit 1
fi

echo "storage.yml guard: OK (no issue #12 paths in diff vs ${BASE})"
