#!/usr/bin/env bash
set -euo pipefail
export IC_STORAGE_EMU_MINIO_PORT="${IC_STORAGE_EMU_MINIO_PORT:-9000}"
export IC_STORAGE_EMU_SFTP_PORT="${IC_STORAGE_EMU_SFTP_PORT:-2222}"
if docker info >/dev/null 2>&1; then
  exec docker compose "$@"
fi
if sudo docker info >/dev/null 2>&1; then
  exec sudo -E env IC_STORAGE_EMU_MINIO_PORT="$IC_STORAGE_EMU_MINIO_PORT" IC_STORAGE_EMU_SFTP_PORT="$IC_STORAGE_EMU_SFTP_PORT" docker compose "$@"
fi
echo "docker compose: no working Docker daemon (tried current user and sudo)" >&2
exit 1
