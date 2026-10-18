#!/usr/bin/env bash
set -euo pipefail
if docker info >/dev/null 2>&1; then
  exec docker compose "$@"
fi
if sudo docker info >/dev/null 2>&1; then
  exec sudo docker compose "$@"
fi
echo "docker compose: no working Docker daemon (tried current user and sudo)" >&2
exit 1
