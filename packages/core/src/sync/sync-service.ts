import { appendMessages } from '../ops/append-messages';
import { createContext } from '../ops/create-context';
import { deleteContextPermanent } from '../ops/delete-context';
import { deleteManyContexts } from '../ops/delete-many';
import { deleteMessages } from '../ops/delete-messages';
import { prunePlaintextVersionHeads } from '../ops/prune-plaintext-versions';
import { updateMessages } from '../ops/update-messages';
import { updateContextMetadataLww } from '../ops/update-context-metadata';
import type { StorageAdapter } from '../storage';
import { clientNodeIdFromMetadata } from '../message-target';
import { generateSyncConflictPublicId } from './public-ids';
import type { SyncRepository, TransactionalSyncRepository } from './repository';
import {
    SYNC_CLIENT_ID_PATTERN,
    type SyncMutation,
    type SyncPullResult,
    type SyncPushResult,
    type SyncConflictRecord,
    SyncPushEffect,
    type SyncPushFailure,
} from './types';

const DEFAULT_PULL_LIMIT = 500;
const MAX_PULL_LIMIT = 1000;
const APPEND_RETRY_ATTEMPTS = 8;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isConcurrentAppendMessage(message: string): boolean {
    return message.includes('Concurrent append');
}

function isClientIdConflictMessage(message: string): boolean {
    return message.includes('already in use');
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateMutation(raw: unknown): SyncMutation | { error: string } {
    if (!isPlainObject(raw)) return { error: 'Each mutation must be an object' };
    const clientId = String(raw.client_id ?? '');
    if (!SYNC_CLIENT_ID_PATTERN.test(clientId)) {
        return { error: 'client_id must be icn_ followed by 24 lowercase hex digits' };
    }
    const op = String(raw.op ?? '');
    if (
        op !== 'context_create' &&
        op !== 'context_fork' &&
        op !== 'context_metadata' &&
        op !== 'message_append' &&
        op !== 'message_update' &&
        op !== 'message_delete' &&
        op !== 'context_delete' &&
        op !== 'contexts_delete_many' &&
        op !== 'prune_plaintext_versions'
    ) {
        return { error: 'Unsupported sync op' };
    }
    const payload = raw.payload;
    if (!isPlainObject(payload)) return { error: 'payload must be an object' };
    const contextId = raw.context_id === undefined ? undefined : String(raw.context_id);
    const updatedAt = raw.updated_at === undefined ? undefined : String(raw.updated_at);
    const baseSequence =
        raw.base_sequence === undefined
            ? payload.base_sequence !== undefined
                ? Number(payload.base_sequence)
                : undefined
            : Number(raw.base_sequence);
    return {
        client_id: clientId,
        op,
        context_id: contextId,
        updated_at: updatedAt,
        base_sequence: Number.isFinite(baseSequence) ? baseSequence : undefined,
        payload,
    };
}

export type SyncApplyContext = {
    userId: number;
    projectId: number;
    sessionId?: number;
    deviceId?: string | null;
};

type ApplyResult =
    | { kind: 'ok'; contextId: string | null; changePayload: Record<string, unknown> & { version?: number } }
    | {
          kind: 'conflict';
          contextId: string;
          conflictKind: string;
          leftPayload: Record<string, unknown>;
          rightPayload: Record<string, unknown>;
          logPayload?: Record<string, unknown>;
      }
    | { kind: 'retryable'; code: string; message: string }
    | { kind: 'failed'; code: string; message: string; contextId?: string };

function isTransactionalSyncRepository(repo: SyncRepository): repo is TransactionalSyncRepository {
    return typeof (repo as TransactionalSyncRepository).runStorageTransaction === 'function';
}

class SyncTransientError extends Error {
    constructor() {
        super('retry');
        this.name = 'SyncTransientError';
    }
}

export class SyncService {
    constructor(
        private storage: StorageAdapter,
        private syncRepo: SyncRepository,
    ) {}

    async getStatus(userId: number) {
        const head = await this.syncRepo.getHeadSequence(userId);
        const conflicts = await this.syncRepo.listConflictsSince(userId, 0, 100);
        return {
            head_sequence: head,
            pending_conflicts: conflicts.length,
        };
    }

    async pullChanges(userId: number, since: number, limit?: number): Promise<SyncPullResult> {
        const safeSince = Number.isFinite(since) && since >= 0 ? Math.floor(since) : 0;
        const pageSize = Math.min(Math.max(limit ?? DEFAULT_PULL_LIMIT, 1), MAX_PULL_LIMIT);
        const head = await this.syncRepo.getHeadSequence(userId);
        const changes = await this.syncRepo.listChanges(userId, safeSince, pageSize + 1);
        const hasMore = changes.length > pageSize;
        const page = hasMore ? changes.slice(0, pageSize) : changes;
        const nextSince = page.length > 0 ? page[page.length - 1]!.sequence : safeSince;
        const conflicts = await this.syncRepo.listConflictsSince(userId, safeSince, 200);
        return {
            changes: page,
            head_sequence: head,
            next_since: nextSince,
            has_more: hasMore,
            conflicts,
        };
    }

    async pushMutations(ctx: SyncApplyContext, rawMutations: unknown[]): Promise<SyncPushResult> {
        if (!Array.isArray(rawMutations)) {
            throw new SyncValidationError('mutations must be an array');
        }

        const applied: string[] = [];
        const duplicate: string[] = [];
        const conflicts: SyncConflictRecord[] = [];
        const effects: SyncPushEffect[] = [];
        const failed: SyncPushFailure[] = [];
        let head = await this.syncRepo.getHeadSequence(ctx.userId);

        for (const raw of rawMutations) {
            const parsed = validateMutation(raw);
            if ('error' in parsed) {
                const rawClientId =
                    isPlainObject(raw) && typeof raw.client_id === 'string' ? String(raw.client_id) : '';
                failed.push({
                    client_id: SYNC_CLIENT_ID_PATTERN.test(rawClientId)
                        ? rawClientId
                        : `icn_${'0'.repeat(24)}`,
                    code: 'invalid_input',
                    message: parsed.error,
                    retryable: false,
                });
                continue;
            }

            const existing = await this.syncRepo.findChangeByClientId(ctx.userId, parsed.client_id);
            if (existing) {
                duplicate.push(parsed.client_id);
                continue;
            }

            const outcome = isTransactionalSyncRepository(this.syncRepo)
                ? await this.pushOneAtomic(ctx, parsed)
                : await this.pushOneLegacy(ctx, parsed);

            head = Math.max(head, outcome.head);
            if (outcome.duplicate) {
                duplicate.push(parsed.client_id);
                continue;
            }
            if (outcome.failed) {
                failed.push(outcome.failed);
                continue;
            }
            if (outcome.conflict) conflicts.push(outcome.conflict);
            if (outcome.applied) applied.push(parsed.client_id);
            if (outcome.effect) effects.push(outcome.effect);
        }

        if (ctx.sessionId) {
            await this.syncRepo.touchSessionSync(ctx.sessionId, new Date().toISOString());
        }

        return {
            head_sequence: head,
            applied,
            duplicate,
            conflicts,
            effects,
            failed: failed.length > 0 ? failed : undefined,
        };
    }

    private async pushOneLegacy(
        ctx: SyncApplyContext,
        parsed: SyncMutation,
    ): Promise<{
        head: number;
        applied?: boolean;
        duplicate?: boolean;
        conflict?: SyncConflictRecord;
        effect?: SyncPushEffect;
        failed?: SyncPushFailure;
    }> {
        const applyResult = await this.applyMutationWithRetry(this.storage, ctx, parsed, {
            listChanges: (since, limit) => this.syncRepo.listChanges(ctx.userId, since, limit),
        });
        return this.finalizePushOutcome(ctx, parsed, applyResult, async (input) => this.syncRepo.appendChange(input), async (input) =>
            this.syncRepo.insertConflict(input),
        );
    }

    private async pushOneAtomic(ctx: SyncApplyContext, parsed: SyncMutation): Promise<{
        head: number;
        applied?: boolean;
        duplicate?: boolean;
        conflict?: SyncConflictRecord;
        effect?: SyncPushEffect;
        failed?: SyncPushFailure;
    }> {
        const txRepo = this.syncRepo as TransactionalSyncRepository;
        for (let attempt = 0; attempt < APPEND_RETRY_ATTEMPTS; attempt += 1) {
            try {
                return await txRepo.runStorageTransaction(async (txCtx) => {
                    const applyResult = await this.applyMutationWithRetry(txCtx.storage, ctx, parsed, {
                        inTransaction: true,
                        listChanges: (since, limit) => txCtx.listChanges(ctx.userId, since, limit),
                    });
                    if (applyResult.kind === 'retryable') {
                        throw new SyncTransientError();
                    }
                    return this.finalizePushOutcome(
                        ctx,
                        parsed,
                        applyResult,
                        (input) => txCtx.appendChange(input),
                        (input) => txCtx.insertConflict(input),
                    );
                });
            } catch (error) {
                if (error instanceof SyncTransientError) {
                    await sleep(5 * (attempt + 1));
                    continue;
                }
                throw error;
            }
        }

        return {
            head: await this.syncRepo.getHeadSequence(ctx.userId),
            failed: {
                client_id: parsed.client_id,
                code: 'concurrent_append_exhausted',
                message: 'Concurrent append retries exhausted',
                retryable: true,
            },
        };
    }

    private async finalizePushOutcome(
        ctx: SyncApplyContext,
        parsed: SyncMutation,
        applyResult: ApplyResult,
        appendChange: (input: {
            userId: number;
            op: string;
            contextId: string | null;
            clientId: string;
            payload: Record<string, unknown>;
            deviceId?: string | null;
        }) => Promise<number>,
        insertConflict: (input: {
            userId: number;
            contextId: string;
            kind: string;
            clientId: string | null;
            sequence: number;
            publicId: string;
            leftPayload: Record<string, unknown>;
            rightPayload: Record<string, unknown>;
        }) => Promise<SyncConflictRecord>,
    ): Promise<{
        head: number;
        applied?: boolean;
        duplicate?: boolean;
        conflict?: SyncConflictRecord;
        effect?: SyncPushEffect;
        failed?: SyncPushFailure;
    }> {
        if (applyResult.kind === 'retryable') {
            return {
                head: await this.syncRepo.getHeadSequence(ctx.userId),
                failed: {
                    client_id: parsed.client_id,
                    code: applyResult.code,
                    message: applyResult.message,
                    retryable: true,
                },
            };
        }

        if (applyResult.kind === 'failed') {
            if (applyResult.code === 'invalid_input') {
                return {
                    head: await this.syncRepo.getHeadSequence(ctx.userId),
                    failed: {
                        client_id: parsed.client_id,
                        code: applyResult.code,
                        message: applyResult.message,
                        retryable: false,
                    },
                };
            }
            const contextId = applyResult.contextId ?? parsed.context_id ?? 'unknown';
            const sequence = await appendChange({
                userId: ctx.userId,
                op: parsed.op,
                contextId,
                clientId: parsed.client_id,
                payload: { ...parsed.payload, conflict: true, code: applyResult.code, message: applyResult.message },
                deviceId: ctx.deviceId ?? null,
            });
            const conflict = await insertConflict({
                userId: ctx.userId,
                contextId,
                kind: applyResult.code,
                clientId: parsed.client_id,
                sequence,
                publicId: generateSyncConflictPublicId(),
                leftPayload: { message: applyResult.message },
                rightPayload: { mutation: parsed.payload },
            });
            return {
                head: sequence,
                applied: true,
                conflict,
                effect: { client_id: parsed.client_id, context_id: contextId },
            };
        }

        if (applyResult.kind === 'conflict') {
            const sequence = await appendChange({
                userId: ctx.userId,
                op: parsed.op,
                contextId: applyResult.contextId,
                clientId: parsed.client_id,
                payload: { ...parsed.payload, conflict: true, ...applyResult.logPayload },
                deviceId: ctx.deviceId ?? null,
            });
            const conflict = await insertConflict({
                userId: ctx.userId,
                contextId: applyResult.contextId,
                kind: applyResult.conflictKind,
                clientId: parsed.client_id,
                sequence,
                publicId: generateSyncConflictPublicId(),
                leftPayload: applyResult.leftPayload,
                rightPayload: applyResult.rightPayload,
            });
            return {
                head: sequence,
                applied: true,
                conflict,
                effect: { client_id: parsed.client_id, context_id: applyResult.contextId },
            };
        }

        const sequence = await appendChange({
            userId: ctx.userId,
            op: parsed.op,
            contextId: applyResult.contextId,
            clientId: parsed.client_id,
            payload: applyResult.changePayload,
            deviceId: ctx.deviceId ?? null,
        });
        return {
            head: sequence,
            applied: true,
            effect: {
                client_id: parsed.client_id,
                context_id: applyResult.contextId ?? undefined,
                version:
                    typeof applyResult.changePayload.version === 'number' ? applyResult.changePayload.version : undefined,
            },
        };
    }

    private async applyMutationWithRetry(
        storage: StorageAdapter,
        ctx: SyncApplyContext,
        mutation: SyncMutation,
        options?: {
            inTransaction?: boolean;
            listChanges?: (since: number, limit: number) => Promise<import('./types').SyncChangeRecord[]>;
        },
    ): Promise<ApplyResult> {
        if (mutation.op !== 'message_append') {
            return this.applyMutation(storage, ctx, mutation, options);
        }

        for (let attempt = 0; attempt < APPEND_RETRY_ATTEMPTS; attempt += 1) {
            const result = await this.applyMutation(storage, ctx, mutation, options);
            if (result.kind !== 'retryable') return result;
            if (options?.inTransaction) return result;
            await sleep(5 * (attempt + 1));
        }
        return {
            kind: 'retryable',
            code: 'concurrent_append_exhausted',
            message: 'Concurrent append retries exhausted',
        };
    }

    private async applyMutation(
        storage: StorageAdapter,
        ctx: SyncApplyContext,
        mutation: SyncMutation,
        options?: {
            listChanges?: (since: number, limit: number) => Promise<import('./types').SyncChangeRecord[]>;
        },
    ): Promise<ApplyResult> {
        if (mutation.op === 'context_create' || mutation.op === 'context_fork') {
            const payload = mutation.payload;
            const metadata = isPlainObject(payload.metadata) ? payload.metadata : {};
            const result = await createContext(storage, ctx.projectId, {
                from: typeof payload.from === 'string' ? payload.from : undefined,
                version: payload.version,
                at: payload.at,
                before: typeof payload.before === 'string' ? payload.before : undefined,
                metadata,
            });
            if (!result.ok) return this.mapApplyError(result.code, result.message, null);
            return {
                kind: 'ok',
                contextId: result.data.id,
                changePayload: {
                    context_id: result.data.id,
                    metadata: result.data.metadata,
                    created_at: result.data.created_at,
                },
            };
        }

        if (mutation.op === 'contexts_delete_many') {
            const ids = (mutation.payload.ids as string[]) ?? [];
            const result = await deleteManyContexts(storage, ctx.projectId, ids);
            if (!result.ok) return this.mapApplyError(result.code, result.message, null, 'contexts_delete_many');
            return {
                kind: 'ok',
                contextId: null,
                changePayload: { results: result.data.results, deleted_count: result.data.deleted_count },
            };
        }

        const contextId = mutation.context_id;
        if (!contextId) throw new SyncValidationError('context_id is required for this op');

        if (mutation.op === 'context_metadata') {
            const metadata = isPlainObject(mutation.payload.metadata) ? mutation.payload.metadata : mutation.payload;
            const updatedAt =
                mutation.updated_at ??
                (typeof mutation.payload.updated_at === 'string' ? mutation.payload.updated_at : new Date().toISOString());
            const result = await updateContextMetadataLww(storage, ctx.projectId, contextId, metadata, updatedAt);
            if (!result.ok) return this.mapApplyError(result.code, result.message, contextId);
            if (!result.data.applied) {
                return {
                    kind: 'conflict',
                    contextId,
                    conflictKind: 'metadata_lww',
                    leftPayload: {
                        metadata: result.data.metadata,
                        updated_at: result.data.existing_updated_at,
                    },
                    rightPayload: {
                        metadata,
                        updated_at: result.data.incoming_updated_at,
                    },
                };
            }
            return {
                kind: 'ok',
                contextId,
                changePayload: {
                    context_id: contextId,
                    metadata: result.data.metadata,
                    updated_at: result.data.incoming_updated_at,
                },
            };
        }

        if (mutation.op === 'message_append') {
            const messages = mutation.payload.messages ?? mutation.payload.message ?? mutation.payload;
            const result = await appendMessages(storage, ctx.projectId, contextId, messages as object | object[]);
            if (!result.ok) {
                if (result.code === 'conflict' && isConcurrentAppendMessage(result.message)) {
                    return { kind: 'retryable', code: 'concurrent_append', message: result.message };
                }
                if (result.code === 'conflict' && isClientIdConflictMessage(result.message)) {
                    return {
                        kind: 'conflict',
                        contextId,
                        conflictKind: 'message_client_id',
                        leftPayload: { message: result.message },
                        rightPayload: { messages },
                    };
                }
                return this.mapApplyError(result.code, result.message, contextId);
            }
            return {
                kind: 'ok',
                contextId,
                changePayload: {
                    context_id: contextId,
                    data: result.data.data,
                    version: result.data.version,
                },
            };
        }

        if (mutation.op === 'message_update') {
            const result = await updateMessages(storage, ctx.projectId, contextId, mutation.payload);
            if (!result.ok) return this.mapApplyError(result.code, result.message, contextId, 'message_update');
            const affectedClientIds = this.extractIcnSelectorsFromUpdatePayload(mutation.payload);
            return {
                kind: 'ok',
                contextId,
                changePayload: {
                    context_id: contextId,
                    version: result.data.version,
                    data: result.data.data,
                    affected_client_ids: affectedClientIds,
                },
            };
        }

        if (mutation.op === 'message_delete') {
            const deleteParams = mutation.payload as { ids?: unknown; base_sequence?: number };
            const rawIds = deleteParams.ids;
            const idList = Array.isArray(rawIds) ? rawIds : rawIds === undefined ? [] : [rawIds];
            const targetClientIds = idList
                .filter((id): id is string => typeof id === 'string' && SYNC_CLIENT_ID_PATTERN.test(id))
                .map(String);
            const baseSeq = mutation.base_sequence ?? deleteParams.base_sequence;
            if (typeof baseSeq !== 'number' || !Number.isFinite(baseSeq)) {
                return {
                    kind: 'failed',
                    code: 'invalid_input',
                    message: 'base_sequence is required for message_delete',
                    contextId,
                };
            }
            const listChanges =
                options?.listChanges ??
                ((since, limit) => this.syncRepo.listChanges(ctx.userId, since, limit));
            const stale = await this.assertDeleteNotStale(contextId, baseSeq, targetClientIds, listChanges);
            if (stale) return stale;
            const result = await deleteMessages(storage, ctx.projectId, contextId, mutation.payload as any);
            if (!result.ok) return this.mapApplyError(result.code, result.message, contextId, 'message_delete');
            return {
                kind: 'ok',
                contextId,
                changePayload: {
                    context_id: contextId,
                    version: result.data.version,
                    deleted_client_ids: result.data.deleted_client_ids,
                },
            };
        }

        if (mutation.op === 'context_delete') {
            const result = await deleteContextPermanent(storage, ctx.projectId, contextId, {});
            if (!result.ok) return this.mapApplyError(result.code, result.message, contextId, 'context_delete');
            return {
                kind: 'ok',
                contextId,
                changePayload: { context_id: contextId, deleted: true },
            };
        }

        if (mutation.op === 'prune_plaintext_versions') {
            const result = await prunePlaintextVersionHeads(storage, ctx.projectId, contextId);
            if (!result.ok) return this.mapApplyError(result.code, result.message, contextId);
            return {
                kind: 'ok',
                contextId,
                changePayload: { context_id: contextId, ...result.data },
            };
        }

        throw new SyncValidationError('Unsupported sync op');
    }

    private extractIcnSelectorsFromUpdatePayload(payload: unknown): string[] {
        const body = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
        const rows = Array.isArray(body.updates)
            ? body.updates
            : Array.isArray(body.data)
              ? body.data
              : [];
        const ids: string[] = [];
        for (const row of rows) {
            if (!row || typeof row !== 'object') continue;
            const id = (row as { id?: unknown }).id;
            if (typeof id === 'string' && SYNC_CLIENT_ID_PATTERN.test(id)) ids.push(id);
        }
        return ids;
    }

    private extractAffectedClientIdsFromChangePayload(payload: Record<string, unknown>): string[] {
        const ids: string[] = [];
        for (const key of ['deleted_client_ids', 'affected_client_ids'] as const) {
            const list = payload[key];
            if (!Array.isArray(list)) continue;
            for (const id of list) {
                if (typeof id === 'string' && SYNC_CLIENT_ID_PATTERN.test(id)) ids.push(id);
            }
        }
        return ids;
    }

    private async listChangesAfterSequence(
        listChanges: (since: number, limit: number) => Promise<import('./types').SyncChangeRecord[]>,
        baseSequence: number,
    ): Promise<import('./types').SyncChangeRecord[]> {
        const all: import('./types').SyncChangeRecord[] = [];
        let since = baseSequence;
        const pageSize = 500;
        while (true) {
            const page = await listChanges(since, pageSize);
            if (page.length === 0) break;
            all.push(...page);
            since = page[page.length - 1]!.sequence;
            if (page.length < pageSize) break;
        }
        return all;
    }

    private async assertDeleteNotStale(
        contextId: string,
        baseSequence: number,
        targetClientIds: string[],
        listChanges: (since: number, limit: number) => Promise<import('./types').SyncChangeRecord[]>,
    ): Promise<ApplyResult | null> {
        const targets = new Set(targetClientIds);
        if (targets.size === 0) return null;
        const changes = await this.listChangesAfterSequence(listChanges, baseSequence);
        for (const change of changes) {
            if (change.context_id !== contextId) continue;
            if (change.sequence <= baseSequence) continue;
            if (change.op !== 'message_update' && change.op !== 'message_delete') {
                continue;
            }
            const touched = this.extractAffectedClientIdsFromChangePayload(change.payload);
            if (touched.some((id) => targets.has(id))) {
                return {
                    kind: 'conflict',
                    contextId,
                    conflictKind: 'delete_stale_base',
                    leftPayload: { base_sequence: baseSequence, server_sequence: change.sequence, op: change.op },
                    rightPayload: { delete_targets: [...targets] },
                };
            }
        }
        return null;
    }

    private mapApplyError(
        code: string,
        message: string,
        contextId: string | null,
        op?: string,
    ): ApplyResult {
        if (code === 'not_found') {
            const contextMissing = message.startsWith('Context not found');
            if (contextMissing || op === 'context_delete') {
                return {
                    kind: 'failed',
                    code: 'context_deleted',
                    message,
                    contextId: contextId ?? undefined,
                };
            }
            return {
                kind: 'failed',
                code: 'message_not_found',
                message,
                contextId: contextId ?? undefined,
            };
        }
        if (code === 'conflict') {
            return {
                kind: 'conflict',
                contextId: contextId ?? 'unknown',
                conflictKind: 'operation_conflict',
                leftPayload: { message },
                rightPayload: {},
            };
        }
        if (code === 'invalid_input') {
            return {
                kind: 'failed',
                code: 'invalid_input',
                message,
                contextId: contextId ?? undefined,
            };
        }
        throw new SyncApplyError(message, code);
    }
}

export class SyncValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SyncValidationError';
    }
}

export class SyncApplyError extends Error {
    constructor(
        message: string,
        readonly code: string,
    ) {
        super(message);
        this.name = 'SyncApplyError';
    }
}
