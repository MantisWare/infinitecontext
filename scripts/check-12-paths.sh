#!/usr/bin/env bash
set -euo pipefail

if [[ "${ALLOW_12_PATHS:-}" == "1" ]]; then
  echo "check-12-paths: ALLOW_12_PATHS=1 — skipping #12 path guard"
  exit 0
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

base_ref=""
if ! git rev-parse --verify origin/main >/dev/null 2>&1; then
  if git remote get-url origin >/dev/null 2>&1; then
    if ! git fetch origin main:refs/remotes/origin/main --quiet 2>/dev/null; then
      git fetch origin main --quiet 2>/dev/null || true
    fi
  fi
fi
if git rev-parse --verify origin/main >/dev/null 2>&1; then
  base_ref="origin/main"
elif git rev-parse --verify main >/dev/null 2>&1; then
  base_ref="main"
else
  echo "check-12-paths: no resolvable base ref (fetch origin main or provide local main)" >&2
  exit 1
fi

if ! mapfile -t touched < <(git diff --name-only "${base_ref}...HEAD" 2>&1); then
  echo "check-12-paths: git diff failed against ${base_ref}" >&2
  exit 1
fi

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
