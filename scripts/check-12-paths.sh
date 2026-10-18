#!/usr/bin/env bash
set -euo pipefail

if [[ "${ALLOW_12_PATHS:-}" == "1" ]]; then
  echo "check-12-paths: ALLOW_12_PATHS=1 — skipping #12 path guard"
  exit 0
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

resolve_base_ref() {
  if ! git rev-parse --verify origin/main >/dev/null 2>&1; then
    if git remote get-url origin >/dev/null 2>&1; then
      git fetch origin main:refs/remotes/origin/main --quiet 2>/dev/null \
        || git fetch origin main --quiet 2>/dev/null \
        || true
    fi
  fi
  if git rev-parse --verify origin/main >/dev/null 2>&1; then
    echo "origin/main"
    return 0
  fi
  if git rev-parse --verify main >/dev/null 2>&1; then
    echo "main"
    return 0
  fi
  echo "check-12-paths: no resolvable base ref (fetch origin main or provide local main)" >&2
  return 1
}

ensure_merge_base() {
  local base_ref="$1"
  if git merge-base "${base_ref}" HEAD >/dev/null 2>&1; then
    return 0
  fi
  if git remote get-url origin >/dev/null 2>&1; then
    echo "check-12-paths: shallow or missing merge base — deepening fetch of ${base_ref}…" >&2
    git fetch origin main --deepen=200 --quiet 2>/dev/null \
      || git fetch origin main --unshallow --quiet 2>/dev/null \
      || git fetch origin main --quiet 2>/dev/null \
      || true
  fi
  if git merge-base "${base_ref}" HEAD >/dev/null 2>&1; then
    return 0
  fi
  echo "check-12-paths: no merge base between ${base_ref} and HEAD (need full history or a deeper fetch)" >&2
  return 1
}

base_ref="$(resolve_base_ref)" || exit 1
ensure_merge_base "${base_ref}" || exit 1

diff_out="$(mktemp)"
diff_err="$(mktemp)"
trap 'rm -f "$diff_out" "$diff_err"' EXIT

if ! git diff --name-only "${base_ref}...HEAD" >"$diff_out" 2>"$diff_err"; then
  if [[ -s "$diff_err" ]]; then
    cat "$diff_err" >&2
  fi
  echo "check-12-paths: git diff failed against ${base_ref}" >&2
  exit 1
fi

mapfile -t touched <"$diff_out"

if ((${#touched[@]} == 0)); then
  echo "check-12-paths: no changed files vs ${base_ref} — ok"
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
