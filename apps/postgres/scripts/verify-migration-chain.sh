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

assert_user_crypto_schema() {
  echo "Asserting user_crypto schema..."
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" <<'SQL'
SELECT
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_crypto' AND column_name = 'wrapped_dek_recovery') AS has_wrapped_dek_recovery,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_crypto' AND column_name = 'crypto_initialized_at') AS has_crypto_initialized_at,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_crypto' AND column_name = 'vault_passphrase_required') AS has_vault_passphrase_required,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_crypto' AND column_name = 'wrapped_dek_prev') AS has_wrapped_dek_prev,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_crypto' AND column_name = 'dek_proof_tag') AS has_dek_proof_tag;
SQL
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" -c \
    "SELECT CASE WHEN
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_crypto' AND column_name = 'wrapped_dek_recovery')
      AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_crypto' AND column_name = 'dek_proof_tag')
     THEN 1 ELSE (1/0) END AS schema_ok;"
}

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
assert_user_crypto_schema
apply_down
apply_up
assert_user_crypto_schema

echo "Migration chain init -> 005 verified (up, down, up) with schema assertions."
