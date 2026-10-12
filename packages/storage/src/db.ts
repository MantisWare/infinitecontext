import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { bigint, bigserial, integer, jsonb, pgTable, text, timestamp, customType } from 'drizzle-orm/pg-core';
import postgres, { type Sql } from 'postgres';

const GLOBAL_DB_REGISTRY_KEY = '__infinitecontextPgRegistry';

export const projects = pgTable('projects', {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    name: text('name').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    public_id: text('public_id'),
});

export const api_keys = pgTable('api_keys', {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    project_id: bigint('project_id', { mode: 'number' }).notNull(),
    key_prefix: text('key_prefix').notNull(),
    key_hash: text('key_hash').notNull(),
    name: text('name'),
    last_used_at: timestamp('last_used_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
    dataType() {
        return 'bytea';
    },
});

export const users = pgTable('users', {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    public_id: text('public_id').notNull(),
    email: text('email').notNull(),
    password_hash: text('password_hash'),
    email_verified_at: timestamp('email_verified_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const identities = pgTable('identities', {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    user_id: bigint('user_id', { mode: 'number' }).notNull(),
    provider: text('provider').notNull(),
    provider_user_id: text('provider_user_id').notNull(),
    email: text('email'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const user_projects = pgTable('user_projects', {
    user_id: bigint('user_id', { mode: 'number' }).primaryKey(),
    project_id: bigint('project_id', { mode: 'number' }).notNull(),
});

export const sessions = pgTable('sessions', {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    public_id: text('public_id').notNull(),
    user_id: bigint('user_id', { mode: 'number' }).notNull(),
    refresh_token_hash: text('refresh_token_hash').notNull(),
    replaced_refresh_token_hash: text('replaced_refresh_token_hash'),
    device_id: text('device_id'),
    device_name: text('device_name'),
    expires_at: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    revoked_at: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    last_used_at: timestamp('last_used_at', { withTimezone: true, mode: 'string' }),
});

export const auth_tokens = pgTable('auth_tokens', {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    user_id: bigint('user_id', { mode: 'number' }).notNull(),
    token_hash: text('token_hash').notNull(),
    kind: text('kind').notNull(),
    expires_at: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    consumed_at: timestamp('consumed_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const oauth_device_flows = pgTable('oauth_device_flows', {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    provider: text('provider').notNull(),
    device_code_hash: text('device_code_hash').notNull(),
    provider_device_code: text('provider_device_code').notNull(),
    user_code: text('user_code').notNull(),
    verification_url: text('verification_url').notNull(),
    expires_at: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    completed_at: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
    tokens_delivered_at: timestamp('tokens_delivered_at', { withTimezone: true, mode: 'string' }),
    user_id: bigint('user_id', { mode: 'number' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const user_crypto = pgTable('user_crypto', {
    user_id: bigint('user_id', { mode: 'number' }).primaryKey(),
    kdf_salt: bytea('kdf_salt'),
    kdf_params: jsonb('kdf_params').$type<Record<string, unknown>>(),
    wrapped_dek: bytea('wrapped_dek'),
    dek_version: integer('dek_version').notNull().default(1),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const nodes = pgTable('nodes', {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    public_id: text('public_id').notNull(),
    project_id: bigint('project_id', { mode: 'number' }).notNull(),
    type: text('type').notNull(),
    content: jsonb('content').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    parent_id: text('parent_id'),
    prev_id: text('prev_id'),
    context_id: text('context_id'),
});

export const schema = {
    projects,
    api_keys,
    nodes,
    users,
    identities,
    user_projects,
    sessions,
    auth_tokens,
    oauth_device_flows,
    user_crypto,
};

export type ApiDb = PostgresJsDatabase<typeof schema>;

type DbRegistry = {
    clients: Map<string, Sql>;
    databases: Map<string, ApiDb>;
};

function resolveDbRegistry(): DbRegistry {
    const globalWithRegistry = globalThis as typeof globalThis & {
        [GLOBAL_DB_REGISTRY_KEY]?: DbRegistry;
    };

    if (!globalWithRegistry[GLOBAL_DB_REGISTRY_KEY]) {
        globalWithRegistry[GLOBAL_DB_REGISTRY_KEY] = {
            clients: new Map<string, Sql>(),
            databases: new Map<string, ApiDb>(),
        };
    }

    return globalWithRegistry[GLOBAL_DB_REGISTRY_KEY]!;
}

export function createDbClient(databaseUrl: string): ApiDb {
    const registry = resolveDbRegistry();
    const existingDb = registry.databases.get(databaseUrl);
    if (existingDb) return existingDb;

    const sqlClient = postgres(databaseUrl, {
        prepare: false,
        max: 5,
        idle_timeout: 20,
        connect_timeout: 10,
    });

    const db = drizzle(sqlClient, { schema });
    registry.clients.set(databaseUrl, sqlClient);
    registry.databases.set(databaseUrl, db);
    return db;
}
