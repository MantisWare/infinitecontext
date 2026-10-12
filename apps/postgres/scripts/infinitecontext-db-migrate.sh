#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POSTGRES_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SCHEMA_FILE="$POSTGRES_DIR/init.sql"

cd "$POSTGRES_DIR"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

DB_USER="${POSTGRES_USER:-infinitecontext}"
DB_NAME="${POSTGRES_DB:-infinitecontext}"

if [[ ! -f "$SCHEMA_FILE" ]]; then
  echo "Schema file not found: $SCHEMA_FILE"
  exit 1
fi

if ! docker compose ps --services --status running | grep -qx "postgres"; then
  echo "Starting postgres service..."
  docker compose up -d postgres
fi

echo "Waiting for postgres to become ready..."
for _ in {1..30}; do
  if docker compose exec -T postgres pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! docker compose exec -T postgres pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
  echo "Postgres did not become ready in time."
  exit 1
fi

echo "Applying schema to database '$DB_NAME' as user '$DB_USER'..."
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < "$SCHEMA_FILE"

MIGRATIONS_DIR="$POSTGRES_DIR/migrations"
if [[ -d "$MIGRATIONS_DIR" ]]; then
  while IFS= read -r migration_file; do
    echo "Applying migration $(basename "$migration_file")..."
    docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < "$migration_file"
  done < <(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' | sort)
fi

echo "Migration complete."
