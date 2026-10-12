import { appendMessages } from '../ops/append-messages';
import { createContext } from '../ops/create-context';
import { updateContextMetadataLww } from '../ops/update-context-metadata';
import type { StorageAdapter } from '../storage';
import { generateSyncConflictPublicId } from './public-ids';
import type { SyncRepository } from './repository';
import {
    SYNC_CLIENT_ID_PATTERN,
    type SyncMutation,
    type SyncPullResult,
    type SyncPushResult,
    type     SyncConflictRecord,
    SyncPushEffect,
} from './types';

const DEFAULT_PULL_LIMIT = 500;
const MAX_PULL_LIMIT = 1000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateMutation(raw: unknown): SyncMutation | { error: string } {
    if (!isPlainObject(raw)) return { error: 'Each mutation must be an object' };
    const clientId = String(raw.client_id ?? '');
    if (!SYNC_CLIENT_ID_PATTERN.test(clientId)) {
        return { error: 'client_id must be icn_ followed by 24 lowercase hex digits' };
    }
    const op = String(raw.op ?? '');
    if (op !== 'context_create' && op !== 'context_metadata' && op !== 'message_append') {
        return { error: 'Unsupported sync op' };
    }
    const payload = raw.payload;
    if (!isPlainObject(payload)) return { error: 'payload must be an object' };
    const contextId = raw.context_id === undefined ? undefined : String(raw.context_id);
    const updatedAt = raw.updated_at === undefined ? undefined : String(raw.updated_at);
    return {
        client_id: clientId,
        op,
        context_id: contextId,
        updated_at: updatedAt,
        payload,
    };
}

export type SyncApplyContext = {
    userId: number;
    projectId: number;
    sessionId?: number;
    deviceId?: string | null;
};

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
        let head = await this.syncRepo.getHeadSequence(ctx.userId);

        for (const raw of rawMutations) {
            const parsed = validateMutation(raw);
            if ('error' in parsed) throw new SyncValidationError(parsed.error);

            const existing = await this.syncRepo.findChangeByClientId(ctx.userId, parsed.client_id);
            if (existing) {
                duplicate.push(parsed.client_id);
                continue;
            }

            const applyResult = await this.applyMutation(ctx, parsed);
            if (applyResult.kind === 'conflict') {
                const sequence = await this.syncRepo.appendChange({
                    userId: ctx.userId,
                    op: parsed.op,
                    contextId: parsed.context_id ?? applyResult.contextId ?? null,
                    clientId: parsed.client_id,
                    payload: { ...parsed.payload, conflict: true, ...applyResult.logPayload },
                    deviceId: ctx.deviceId ?? null,
                });
                head = sequence;
                const conflict = await this.syncRepo.insertConflict({
                    userId: ctx.userId,
                    contextId: applyResult.contextId,
                    kind: applyResult.conflictKind,
                    clientId: parsed.client_id,
                    sequence,
                    publicId: generateSyncConflictPublicId(),
                    leftPayload: applyResult.leftPayload,
                    rightPayload: applyResult.rightPayload,
                });
                conflicts.push(conflict);
                applied.push(parsed.client_id);
                effects.push({ client_id: parsed.client_id, context_id: applyResult.contextId });
                continue;
            }

            const sequence = await this.syncRepo.appendChange({
                userId: ctx.userId,
                op: parsed.op,
                contextId: applyResult.contextId,
                clientId: parsed.client_id,
                payload: applyResult.changePayload,
                deviceId: ctx.deviceId ?? null,
            });
            head = sequence;
            applied.push(parsed.client_id);
            effects.push({
                client_id: parsed.client_id,
                context_id: applyResult.contextId ?? undefined,
                version:
                    applyResult.kind === 'ok' && typeof applyResult.changePayload.version === 'number'
                        ? applyResult.changePayload.version
                        : undefined,
            });
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
        };
    }

    private async applyMutation(
        ctx: SyncApplyContext,
        mutation: SyncMutation,
    ): Promise<
        | { kind: 'ok'; contextId: string | null; changePayload: Record<string, unknown> & { version?: number } }
        | {
              kind: 'conflict';
              contextId: string;
              conflictKind: string;
              leftPayload: Record<string, unknown>;
              rightPayload: Record<string, unknown>;
              logPayload?: Record<string, unknown>;
          }
    > {
        if (mutation.op === 'context_create') {
            const metadata = isPlainObject(mutation.payload.metadata) ? mutation.payload.metadata : {};
            const result = await createContext(this.storage, ctx.projectId, { metadata });
            if (!result.ok) throw new SyncApplyError(result.message, result.code);
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

        const contextId = mutation.context_id;
        if (!contextId) throw new SyncValidationError('context_id is required for this op');

        if (mutation.op === 'context_metadata') {
            const metadata = isPlainObject(mutation.payload.metadata) ? mutation.payload.metadata : mutation.payload;
            const updatedAt =
                mutation.updated_at ??
                (typeof mutation.payload.updated_at === 'string' ? mutation.payload.updated_at : new Date().toISOString());
            const result = await updateContextMetadataLww(this.storage, ctx.projectId, contextId, metadata, updatedAt);
            if (!result.ok) throw new SyncApplyError(result.message, result.code);
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
            const result = await appendMessages(this.storage, ctx.projectId, contextId, messages as object | object[]);
            if (!result.ok) {
                if (result.code === 'conflict') {
                    return {
                        kind: 'conflict',
                        contextId,
                        conflictKind: 'message_client_id',
                        leftPayload: { message: result.message },
                        rightPayload: { messages },
                    };
                }
                throw new SyncApplyError(result.message, result.code);
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

        throw new SyncValidationError('Unsupported sync op');
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
