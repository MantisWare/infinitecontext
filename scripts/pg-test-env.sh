#!/usr/bin/env bash
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-ic-local-test-postgres-password}"
export POSTGRES_USER="${POSTGRES_USER:-infinitecontext}"
export PGHOST="${PGHOST:-127.0.0.1}"
export PGPORT="${PGPORT:-5432}"
export SYNC_E2E_DATABASE_URL="${SYNC_E2E_DATABASE_URL:-postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${PGHOST}:${PGPORT}/infinitecontext_sync_e2e}"
export VAULT_E2E_DATABASE_URL="${VAULT_E2E_DATABASE_URL:-$SYNC_E2E_DATABASE_URL}"
