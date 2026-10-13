#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POSTGRES_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS_DIR="$POSTGRES_DIR/migrations"

cd "$POSTGRES_DIR"

DB_USER="${POSTGRES_USER:-infinitecontext}"
DB_NAME="${POSTGRES_DB:-infinitecontext_verify}"
PG_HOST="${PGHOST:-127.0.0.1}"
PG_PORT="${PGPORT:-5432}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-infinitecontext_migration_verify}"

if [[ -z "${POSTGRES_PASSWORD:-}" ]]; then
  echo "POSTGRES_PASSWORD is required (no default)." >&2
  exit 1
fi
DB_PASS="$POSTGRES_PASSWORD"

export COMPOSE_PROJECT_NAME

PSQL=(psql -h "$PG_HOST" -p "$PG_PORT" -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME")
export PGPASSWORD="$DB_PASS"

assert_user_crypto_schema() {
  echo "Asserting user_crypto schema..."
  "${PSQL[@]}" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_crypto' AND column_name = 'wrapped_dek_recovery'
  ) THEN
    RAISE EXCEPTION 'missing wrapped_dek_recovery column';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_crypto' AND column_name = 'dek_proof_tag'
  ) THEN
    RAISE EXCEPTION 'missing dek_proof_tag column';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_crypto' AND column_name = 'wrapped_dek_prev'
  ) THEN
    RAISE EXCEPTION 'missing wrapped_dek_prev column';
  END IF;
END $$;
SQL
}

apply_up() {
  echo "Applying init.sql..."
  "${PSQL[@]}" < "$POSTGRES_DIR/init.sql"
  while IFS= read -r migration_file; do
    echo "Applying $(basename "$migration_file")..."
    "${PSQL[@]}" < "$migration_file"
  done < <(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' ! -name '*.down.sql' | sort)
}

apply_down() {
  while IFS= read -r migration_file; do
    echo "Reverting $(basename "$migration_file")..."
    "${PSQL[@]}" < "$migration_file"
  done < <(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.down.sql' | sort -r)
}

use_docker=false
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  use_docker=true
fi

if [[ "$use_docker" == true ]]; then
  echo "Starting isolated postgres via docker compose..."
  docker compose up -d postgres
  echo "Waiting for postgres..."
  for _ in {1..30}; do
    if docker compose exec -T postgres pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  PSQL=(docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME")
else
  echo "Docker unavailable — using local PostgreSQL (${DB_NAME})..."
  export PGPASSWORD="$DB_PASS"
  if ! command -v psql >/dev/null 2>&1; then
    echo "psql not found. Install PostgreSQL client/server." >&2
    exit 1
  fi
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DO \$\$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
      CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}';
    END IF;
  END \$\$;"
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};" 2>/dev/null || true
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER DATABASE ${DB_NAME} OWNER TO ${DB_USER};" 2>/dev/null || true
  PSQL=(psql -h "$PG_HOST" -p "$PG_PORT" -U "$DB_USER" -d "$DB_NAME")
fi

assert_sync_schema() {
  echo "Asserting sync schema..."
  "${PSQL[@]}" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'sync_change_log'
  ) THEN
    RAISE EXCEPTION 'missing sync_change_log table';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sessions' AND column_name = 'last_sync_at'
  ) THEN
    RAISE EXCEPTION 'missing sessions.last_sync_at column';
  END IF;
END $$;
SQL
}

apply_up
assert_user_crypto_schema
assert_sync_schema
apply_down
apply_up
assert_user_crypto_schema
assert_sync_schema

echo "Asserting migration 008 icn backfill (pgcrypto)..."
"${PSQL[@]}" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    RAISE EXCEPTION 'pgcrypto extension missing after 008';
  END IF;
END $$;
SQL

echo "Migration chain init -> latest verified (up, down, up) with schema assertions."
