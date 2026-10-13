import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';

import { SyncChangeLogClientIdConflict } from '@infinitecontext/core/sync';
import type {
    SyncRepository,
    SyncAppendChangeInput,
    SyncStorageTransactionContext,
    TransactionalSyncRepository,
} from '@infinitecontext/core/sync';
import type { SyncChangeRecord, SyncConflictRecord } from '@infinitecontext/core/sync';

import { DrizzleAdapter } from '../drizzle';
import { sync_change_log, sync_conflicts, sync_user_state, sessions, type ApiDb } from '../db';

function mapChange(row: typeof sync_change_log.$inferSelect): SyncChangeRecord {
    return {
        sequence: Number(row.sequence),
        op: row.op as SyncChangeRecord['op'],
        context_id: row.context_id ?? null,
        client_id: row.client_id,
        payload: row.payload ?? {},
        device_id: row.device_id ?? null,
        created_at: row.created_at,
    };
}

function mapConflict(row: typeof sync_conflicts.$inferSelect): SyncConflictRecord {
    return {
        id: row.public_id,
        context_id: row.context_id,
        kind: row.kind,
        client_id: row.client_id ?? null,
        sequence: Number(row.sequence),
        left_payload: row.left_payload ?? {},
        right_payload: row.right_payload ?? {},
        created_at: row.created_at,
        resolved_at: row.resolved_at ?? null,
    };
}

export class DrizzleSyncRepository implements SyncRepository, TransactionalSyncRepository {
    constructor(private db: ApiDb) {}

    async getHeadSequence(userId: number): Promise<number> {
        return this.getHeadSequenceOnDb(this.db, userId);
    }

    private async getHeadSequenceOnDb(db: ApiDb, userId: number): Promise<number> {
        const rows = await db
            .select({ head: sync_user_state.head_sequence })
            .from(sync_user_state)
            .where(eq(sync_user_state.user_id, userId))
            .limit(1);
        return rows[0] ? Number(rows[0].head) : 0;
    }

    async findChangeByClientId(userId: number, clientId: string) {
        const rows = await this.db
            .select({
                sequence: sync_change_log.sequence,
                payload: sync_change_log.payload,
                op: sync_change_log.op,
            })
            .from(sync_change_log)
            .where(and(eq(sync_change_log.user_id, userId), eq(sync_change_log.client_id, clientId)))
            .limit(1);
        const row = rows[0];
        if (!row) return null;
        return {
            sequence: Number(row.sequence),
            payload: row.payload ?? {},
            op: row.op,
        };
    }

    async appendChange(input: SyncAppendChangeInput): Promise<number> {
        return this.db.transaction(async (tx) => this.appendChangeOnDb(tx as ApiDb, input));
    }

    private async appendChangeOnDb(txDb: ApiDb, input: SyncAppendChangeInput): Promise<number> {
        const clientId = input.clientId?.trim() ?? '';
        const hasIdempotencyKey = clientId.length > 0;

        await txDb
            .insert(sync_user_state)
            .values({ user_id: input.userId, head_sequence: 0 })
            .onConflictDoNothing();

        const bumped = await txDb
            .update(sync_user_state)
            .set({ head_sequence: sql`${sync_user_state.head_sequence} + 1` })
            .where(eq(sync_user_state.user_id, input.userId))
            .returning({ sequence: sync_user_state.head_sequence });

        const sequence = Number(bumped[0]?.sequence ?? 0);
        if (!sequence) {
            throw new Error('Failed to allocate sync sequence');
        }

        if (hasIdempotencyKey) {
            const inserted = await txDb
                .insert(sync_change_log)
                .values({
                    user_id: input.userId,
                    sequence,
                    op: input.op,
                    context_id: input.contextId,
                    client_id: clientId,
                    payload: input.payload,
                    device_id: input.deviceId ?? null,
                })
                .onConflictDoNothing({ target: [sync_change_log.user_id, sync_change_log.client_id] })
                .returning({ sequence: sync_change_log.sequence });

            if (inserted.length === 0) {
                throw new SyncChangeLogClientIdConflict(input.userId, clientId);
            }
            return Number(inserted[0]!.sequence);
        }

        await txDb.insert(sync_change_log).values({
            user_id: input.userId,
            sequence,
            op: input.op,
            context_id: input.contextId,
            client_id: clientId,
            payload: input.payload,
            device_id: input.deviceId ?? null,
        });

        return sequence;
    }

    async runStorageTransaction<T>(fn: (ctx: SyncStorageTransactionContext) => Promise<T>): Promise<T> {
        return this.db.transaction(async (tx) => {
            const txDb = tx as ApiDb;
            const ctx: SyncStorageTransactionContext = {
                storage: new DrizzleAdapter(txDb),
                getHeadSequence: (userId) => this.getHeadSequenceOnDb(txDb, userId),
                listChanges: (userId, since, limit) => this.listChangesOnDb(txDb, userId, since, limit),
                appendChange: (input) => this.appendChangeOnDb(txDb, input),
                insertConflict: (input) => this.insertConflictOnDb(txDb, input),
                hasMessageClientMutationSince: (userId, contextId, sinceSequence, clientNodeIds) =>
                    this.hasMessageClientMutationSinceOnDb(txDb, userId, contextId, sinceSequence, clientNodeIds),
            };
            return fn(ctx);
        });
    }

    private async insertConflictOnDb(
        txDb: ApiDb,
        input: {
            userId: number;
            contextId: string;
            kind: string;
            clientId: string | null;
            sequence: number;
            publicId: string;
            leftPayload: Record<string, unknown>;
            rightPayload: Record<string, unknown>;
        },
    ): Promise<SyncConflictRecord> {
        const rows = await txDb
            .insert(sync_conflicts)
            .values({
                public_id: input.publicId,
                user_id: input.userId,
                context_id: input.contextId,
                kind: input.kind,
                client_id: input.clientId,
                sequence: input.sequence,
                left_payload: input.leftPayload,
                right_payload: input.rightPayload,
            })
            .returning();
        return mapConflict(rows[0]!);
    }

    private async listChangesOnDb(db: ApiDb, userId: number, since: number, limit: number): Promise<SyncChangeRecord[]> {
        const rows = await db
            .select()
            .from(sync_change_log)
            .where(and(eq(sync_change_log.user_id, userId), gt(sync_change_log.sequence, since)))
            .orderBy(asc(sync_change_log.sequence))
            .limit(limit);
        return rows.map(mapChange);
    }

    async listChanges(userId: number, since: number, limit: number): Promise<SyncChangeRecord[]> {
        return this.listChangesOnDb(this.db, userId, since, limit);
    }

    async hasMessageClientMutationSince(
        userId: number,
        contextId: string,
        sinceSequence: number,
        clientNodeIds: string[],
    ): Promise<boolean> {
        return this.hasMessageClientMutationSinceOnDb(this.db, userId, contextId, sinceSequence, clientNodeIds);
    }

    private async hasMessageClientMutationSinceOnDb(
        db: ApiDb,
        userId: number,
        contextId: string,
        sinceSequence: number,
        clientNodeIds: string[],
    ): Promise<boolean> {
        if (clientNodeIds.length === 0) return false;
        const overlap = sql.join(
            clientNodeIds.flatMap((id) => [
                sql`COALESCE(${sync_change_log.payload}->'affected_client_ids', '[]'::jsonb) @> ${JSON.stringify([id])}::jsonb`,
                sql`COALESCE(${sync_change_log.payload}->'deleted_client_ids', '[]'::jsonb) @> ${JSON.stringify([id])}::jsonb`,
            ]),
            sql` OR `,
        );
        const rows = await db.execute(sql`
            SELECT EXISTS (
                SELECT 1
                FROM ${sync_change_log}
                WHERE ${sync_change_log.user_id} = ${userId}
                  AND ${sync_change_log.context_id} = ${contextId}
                  AND ${sync_change_log.sequence} > ${sinceSequence}
                  AND ${sync_change_log.op} IN ('message_update', 'message_delete')
                  AND (${overlap})
            ) AS stale
        `);
        const row = (Array.isArray(rows) ? rows[0] : (rows as { rows?: unknown[] }).rows?.[0]) as
            | { stale?: boolean }
            | undefined;
        return Boolean(row?.stale);
    }

    async insertConflict(input: {
        userId: number;
        contextId: string;
        kind: string;
        clientId: string | null;
        sequence: number;
        publicId: string;
        leftPayload: Record<string, unknown>;
        rightPayload: Record<string, unknown>;
    }): Promise<SyncConflictRecord> {
        const rows = await this.db
            .insert(sync_conflicts)
            .values({
                public_id: input.publicId,
                user_id: input.userId,
                context_id: input.contextId,
                kind: input.kind,
                client_id: input.clientId,
                sequence: input.sequence,
                left_payload: input.leftPayload,
                right_payload: input.rightPayload,
            })
            .returning();
        return mapConflict(rows[0]!);
    }

    async listConflictsSince(userId: number, sinceSequence: number, limit: number): Promise<SyncConflictRecord[]> {
        const rows = await this.db
            .select()
            .from(sync_conflicts)
            .where(and(eq(sync_conflicts.user_id, userId), gt(sync_conflicts.sequence, sinceSequence), isNull(sync_conflicts.resolved_at)))
            .orderBy(asc(sync_conflicts.sequence))
            .limit(limit);
        return rows.map(mapConflict);
    }

    async touchSessionSync(sessionId: number, at: string): Promise<void> {
        await this.db.update(sessions).set({ last_sync_at: at }).where(eq(sessions.id, sessionId));
    }
}
