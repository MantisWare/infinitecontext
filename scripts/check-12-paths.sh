#!/usr/bin/env bash
# Guard #12 paths vs origin/main. Uses three-dot (merge-base..HEAD) when a merge base exists;
# shallow/single-commit HEADs fall back to depth-1 main fetch + two-dot diff.
set -euo pipefail

if [[ "${ALLOW_12_PATHS:-}" == "1" ]]; then
  echo "check-12-paths: ALLOW_12_PATHS=1 — skipping #12 path guard"
  exit 0
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

CHECK12_TMP_REF="refs/tmp/check12-main-depth1"

cleanup_check12_ref() {
  git update-ref -d "${CHECK12_TMP_REF}" 2>/dev/null || true
}

resolve_main_snapshot_ref() {
  cleanup_check12_ref
  if git rev-parse --verify origin/main >/dev/null 2>&1; then
    echo "origin/main"
    return 0
  fi
  if ! git remote get-url origin >/dev/null 2>&1; then
    echo "check-12-paths: no origin remote and no origin/main" >&2
    return 1
  fi
  echo "check-12-paths: fetching origin/main (depth 1) into ${CHECK12_TMP_REF}…" >&2
  if ! git fetch origin refs/heads/main:"${CHECK12_TMP_REF}" --depth=1 --quiet 2>/dev/null; then
    git fetch origin main:"${CHECK12_TMP_REF}" --quiet 2>/dev/null || true
  fi
  if git rev-parse --verify "${CHECK12_TMP_REF}" >/dev/null 2>&1; then
    echo "${CHECK12_TMP_REF}"
    return 0
  fi
  if git rev-parse --verify main >/dev/null 2>&1; then
    echo "main"
    return 0
  fi
  echo "check-12-paths: could not resolve main snapshot ref" >&2
  return 1
}

diff_out="$(mktemp)"
diff_err="$(mktemp)"
trap 'rm -f "$diff_out" "$diff_err"; cleanup_check12_ref' EXIT

main_ref="$(resolve_main_snapshot_ref)" || exit 1

use_three_dot=0
if git merge-base "${main_ref}" HEAD >/dev/null 2>&1; then
  use_three_dot=1
  echo "check-12-paths: using three-dot diff (${main_ref}...HEAD)" >&2
  if ! git diff --name-only "${main_ref}"...HEAD >"$diff_out" 2>"$diff_err"; then
    if [[ -s "$diff_err" ]]; then
      cat "$diff_err" >&2
    fi
    echo "check-12-paths: git diff failed (${main_ref}...HEAD)" >&2
    exit 1
  fi
else
  echo "check-12-paths: using two-dot diff (${main_ref}..HEAD, no merge base)" >&2
  if ! git diff --name-only "${main_ref}" HEAD >"$diff_out" 2>"$diff_err"; then
    if [[ -s "$diff_err" ]]; then
      cat "$diff_err" >&2
    fi
    echo "check-12-paths: git diff failed (${main_ref}..HEAD)" >&2
    exit 1
  fi
fi

mapfile -t touched <"$diff_out"

if ((${#touched[@]} == 0)); then
  if ((use_three_dot)); then
    echo "check-12-paths: no changed files vs ${main_ref}...HEAD — ok"
  else
    echo "check-12-paths: no changed files vs ${main_ref}..HEAD — ok"
  fi
  exit 0
fi

blocked=()
for path in "${touched[@]}"; do
  case "$path" in
    apps/api/src/routes/contexts.ts|apps/api/src/routes/update-messages.ts)
      blocked+=("$path")
      ;;
    apps/api/src/sync/*)
      blocked+=("$path")
      ;;
    apps/js-sdk/lib/*update-message*)
      blocked+=("$path")
      ;;
  esac
done

if ((${#blocked[@]} > 0)); then
  echo "check-12-paths: BLOCKED — diff touches out-of-scope #12 paths:" >&2
  printf '  %s\n' "${blocked[@]}" >&2
  echo "Override only with Dev Lead approval: ALLOW_12_PATHS=1" >&2
  exit 1
fi

echo "check-12-paths: ok (${#touched[@]} changed file(s), none in #12 guard list)"
