#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POSTGRES_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS_DIR="$POSTGRES_DIR/migrations"

cd "$POSTGRES_DIR"

DB_USER="${POSTGRES_USER:-infinitecontext}"
DB_NAME="${POSTGRES_DB:-infinitecontext_verify}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-infinitecontext_migration_verify}"

export COMPOSE_PROJECT_NAME

echo "Starting isolated postgres for migration verification..."
docker compose up -d postgres

echo "Waiting for postgres..."
for _ in {1..30}; do
  if docker compose exec -T postgres pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

apply_up() {
  echo "Applying init.sql..."
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < "$POSTGRES_DIR/init.sql"
  while IFS= read -r migration_file; do
    echo "Applying $(basename "$migration_file")..."
    docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < "$migration_file"
  done < <(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' ! -name '*.down.sql' | sort)
}

apply_down() {
  while IFS= read -r migration_file; do
    echo "Reverting $(basename "$migration_file")..."
    docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < "$migration_file"
  done < <(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.down.sql' | sort -r)
}

apply_up
apply_down
apply_up

echo "Migration chain init -> 001 -> 004 verified (up, down, up)."
