import {
    appendMessages,
    prunePlaintextVersionHeads,
    createContext,
    deleteContextPermanent,
    deleteManyContexts,
    deleteMessages,
    getContext,
    isPlainObject,
    listContexts,
    resultStatus,
    updateMessages,
    type ContextFilters,
    type ErrorCode,
} from '@infinitecontext/core';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AuthRepository } from '@infinitecontext/auth';

import {
    applyVaultMigrateReadGate,
    validateVaultContextWrite,
    validateVaultDeleteWrite,
    validateVaultEncryptedMessageWriteToContext,
    validateVaultHistoricalRead,
    validateVaultMessageRead,
    validateVaultPrunePlaintextVersions,
    type VaultEncryptionDeps,
} from '../middleware/vault-encryption';
import { generateSyncConflictPublicId, type SyncRepository } from '@infinitecontext/core/sync';

import {
    recordContextCreateChange,
    recordGenericSyncChange,
    recordMessageAppendChanges,
    syncSessionMeta,
} from '../sync/context-sync-hooks';
import { parseBaseSequence } from '../sync/parse-base-sequence';
import { assertRestMessageDeleteNotStale, resolveDeleteTargetClientIds } from '../sync/rest-message-delete';
import { asTransactionalSyncRepository } from '../sync/transactional-sync';
import type { HttpApp } from '../types/http';
import { generateClientNodeId } from '@infinitecontext/crypto';

// -- error status (core code -> Hono-typed HTTP status) -----------------------

const status = (code: ErrorCode) => resultStatus(code) as ContentfulStatusCode;

// -- routes -------------------------------------------------------------------

export function registerContextRoutes(
    app: HttpApp,
    options?: { authRepo?: AuthRepository | null; syncRepo?: SyncRepository | null },
) {
    const vaultDeps: VaultEncryptionDeps | null = options?.authRepo ? { authRepo: options.authRepo } : null;
    const syncRepo = options?.syncRepo ?? null;

    // create context — parse body (default {} on bad JSON), call core, map Result
    app.post('/contexts', async (c) => {
        const { projectId } = c.get('auth');
        const storage = c.get('storage');
        const body = await c.req.json().catch(() => ({}));

        if (vaultDeps) {
            const denied = await validateVaultContextWrite(c, vaultDeps, body, 'create_root');
            if (denied) return denied;
        }

        const result = await createContext(storage, projectId, body);
        if (!result.ok) return c.json({ error: result.message }, status(result.code));
        const syncMeta = await syncSessionMeta(c, options?.authRepo);
        if (syncMeta) {
            await recordContextCreateChange(syncRepo, syncMeta, body, result.data);
        }
        return c.json(result.data, 201);
    });

    // list contexts — parse query params + filters, call core listContexts
    app.get('/contexts', async (c) => {
        const { projectId } = c.get('auth');
        const storage = c.get('storage');
        const limit = parseInt(c.req.query('limit') ?? '20');

        // metadata + timestamp filters
        const filters: ContextFilters & { limit?: number } = { limit };
        const source = c.req.query('source');
        const userId = c.req.query('user_id');
        const host = c.req.query('host');
        const projectPath = c.req.query('project_path');
        const sessionId = c.req.query('session_id');
        const after = c.req.query('after');
        const before = c.req.query('before');
        if (source) filters.source = source;
        if (userId) filters.user_id = userId;
        if (host) filters.host = host;
        if (projectPath) filters.project_path = projectPath;
        if (sessionId) filters.session_id = sessionId;
        if (after) {
            if (isNaN(Date.parse(after))) return c.json({ error: 'Invalid after timestamp' }, 400);
            filters.after = after;
        }
        if (before) {
            if (isNaN(Date.parse(before))) return c.json({ error: 'Invalid before timestamp' }, 400);
            filters.before = before;
        }

        const data = await listContexts(storage, projectId, filters);
        return c.json(data);
    });

    // -- delete-many contexts (must be registered before :id routes) -----------

    // delete-many — parse body (must be JSON object), call core, compute status
    app.post('/contexts/delete-many', async (c) => {
        const { projectId } = c.get('auth');
        const storage = c.get('storage');
        const body = await c.req.json().catch(() => null);

        if (!isPlainObject(body)) return c.json({ error: 'Request body must be a JSON object' }, 400);

        const { ids } = body;
        const result = await deleteManyContexts(storage, projectId, ids as string[]);
        if (!result.ok) return c.json({ error: result.message }, status(result.code));

        // 207 Multi-Status when partial failure; 500 if every item failed
        const { deleted_count } = result.data;
        const total = result.data.results.length;
        const httpStatus = deleted_count === 0 ? 500 : deleted_count === total ? 200 : 207;
        const syncMeta = await syncSessionMeta(c, options?.authRepo);
        if (syncMeta && deleted_count > 0) {
            await recordGenericSyncChange(syncRepo, syncMeta, {
                op: 'contexts_delete_many',
                contextId: null,
                payload: { ids, results: result.data.results, deleted_count },
            });
        }
        return c.json(result.data, httpStatus);
    });

    // -- parameterized :id routes ------------------------------------------------

    // append messages — parse JSON body (no catch, matches prior behavior)
    app.post('/contexts/:id', async (c) => {
        const { projectId } = c.get('auth');
        const storage = c.get('storage');
        const contextPublicId = c.req.param('id');
        const body = await c.req.json();

        if (vaultDeps) {
            const denied =
                (await validateVaultContextWrite(c, vaultDeps, body, 'messages', {
                    newMessageIdsOnly: true,
                })) ??
                (await validateVaultEncryptedMessageWriteToContext(c, vaultDeps, storage, projectId, contextPublicId));
            if (denied) return denied;
        }

        const result = await appendMessages(storage, projectId, contextPublicId, body);
        if (!result.ok) return c.json({ error: result.message }, status(result.code));
        const syncMeta = await syncSessionMeta(c, options?.authRepo);
        if (syncMeta) {
            await recordMessageAppendChanges(syncRepo, syncMeta, contextPublicId, body, result.data);
        }
        if (syncMeta && syncRepo) {
            return c.json(
                { ...result.data, sync_base_sequence: await syncRepo.getHeadSequence(syncMeta.userId) },
                201,
            );
        }
        return c.json(result.data, 201);
    });

    app.post('/contexts/:id/prune-plaintext-versions', async (c) => {
        const { projectId } = c.get('auth');
        const storage = c.get('storage');
        const contextPublicId = c.req.param('id');

        if (vaultDeps) {
            const denied = await validateVaultPrunePlaintextVersions(c, vaultDeps, storage, projectId, contextPublicId);
            if (denied) return denied;
        }

        const result = await prunePlaintextVersionHeads(storage, projectId, contextPublicId);
        if (!result.ok) return c.json({ error: result.message }, status(result.code));
        const syncMeta = await syncSessionMeta(c, options?.authRepo);
        if (syncMeta) {
            await recordGenericSyncChange(syncRepo, syncMeta, {
                op: 'prune_plaintext_versions',
                contextId: contextPublicId,
                payload: { context_id: contextPublicId, ...result.data },
            });
        }
        return c.json(result.data);
    });

    // get context — parse query selectors, call core, map Result
    app.get('/contexts/:id', async (c) => {
        const { projectId } = c.get('auth');
        const storage = c.get('storage');
        const contextPublicId = c.req.param('id');

        const opts = {
            version: c.req.query('version'),
            at: c.req.query('at'),
            before: c.req.query('before'),
            history: c.req.query('history') === 'true',
        };

        const syncMeta = await syncSessionMeta(c, options?.authRepo);
        const txSyncRepo = asTransactionalSyncRepository(syncRepo);
        let result: Awaited<ReturnType<typeof getContext>>;
        let syncHead: number | undefined;
        if (syncMeta && txSyncRepo) {
            const snapshot = await txSyncRepo.runStorageTransaction(async (txCtx) => {
                const ctxResult = await getContext(txCtx.storage, projectId, contextPublicId, opts);
                const head = await txCtx.getHeadSequence(syncMeta.userId);
                return { ctxResult, head };
            });
            result = snapshot.ctxResult;
            syncHead = snapshot.head;
        } else {
            result = await getContext(storage, projectId, contextPublicId, opts);
            if (syncMeta && syncRepo) {
                syncHead = await syncRepo.getHeadSequence(syncMeta.userId);
            }
        }
        if (!result.ok) return c.json({ error: result.message }, status(result.code));

        if (vaultDeps) {
            const migrateGate = applyVaultMigrateReadGate(c);
            if (migrateGate.denied) return migrateGate.denied;
            const denied =
                (await validateVaultHistoricalRead(c, vaultDeps, opts, result.data, migrateGate.allowLegacyMigrateRead)) ??
                (await validateVaultMessageRead(c, vaultDeps, result.data, {
                    allowLegacyMigrateRead: migrateGate.allowLegacyMigrateRead,
                }));
            if (denied) return denied;
        }

        const responseBody =
            syncMeta && syncRepo && syncHead !== undefined
                ? { ...result.data, sync_base_sequence: syncHead }
                : result.data;
        return c.json(responseBody);
    });

    // update messages — parse JSON body (null on bad JSON -> 400), call core
    app.patch('/contexts/:id', async (c) => {
        const { projectId } = c.get('auth');
        const storage = c.get('storage');
        const contextPublicId = c.req.param('id');
        const body = await c.req.json().catch(() => null);

        if (body === null) return c.json({ error: 'Invalid JSON body' }, 400);

        if (vaultDeps) {
            const denied = await validateVaultContextWrite(c, vaultDeps, body, 'messages');
            if (denied) return denied;
        }

        const parsedBase = parseBaseSequence(c, body);
        if (parsedBase.status === 'invalid') {
            return c.json({ error: 'Invalid base_sequence' }, 400);
        }
        const syncMeta = await syncSessionMeta(c, options?.authRepo);
        const txSyncRepo = asTransactionalSyncRepository(syncRepo);
        const patchClientId = generateClientNodeId();

        if (syncMeta && txSyncRepo) {
            const atomic = await txSyncRepo.runStorageTransaction(async (txCtx) => {
                if (parsedBase.status === 'ok') {
                    const head = await txCtx.getHeadSequence(syncMeta.userId);
                    if (parsedBase.value > head) {
                        return { kind: 'invalid_base' as const };
                    }
                }
                const updateResult = await updateMessages(txCtx.storage, projectId, contextPublicId, body, {
                    inTransaction: true,
                });
                if (!updateResult.ok) {
                    return { kind: 'update_error' as const, updateResult };
                }
                await txCtx.appendChange({
                    userId: syncMeta.userId,
                    op: 'message_update',
                    contextId: contextPublicId,
                    clientId: patchClientId,
                    payload: {
                        context_id: contextPublicId,
                        version: updateResult.data.version,
                        data: updateResult.data.data,
                        affected_client_ids: updateResult.data.affected_client_ids,
                    },
                    deviceId: syncMeta.deviceId ?? null,
                });
                const syncHead = await txCtx.getHeadSequence(syncMeta.userId);
                return { kind: 'ok' as const, updateResult, syncHead };
            });
            if (atomic.kind === 'invalid_base') {
                return c.json({ error: 'Invalid base_sequence' }, 400);
            }
            if (atomic.kind === 'update_error') {
                const updateResult = atomic.updateResult;
                return c.json({ error: updateResult.message }, status(updateResult.code));
            }
            return c.json({
                ...atomic.updateResult.data,
                sync_base_sequence: atomic.syncHead,
            });
        }

        if (syncMeta && syncRepo && parsedBase.status === 'ok') {
            const head = await syncRepo.getHeadSequence(syncMeta.userId);
            if (parsedBase.value > head) {
                return c.json({ error: 'Invalid base_sequence' }, 400);
            }
        }
        const result = await updateMessages(storage, projectId, contextPublicId, body);
        if (!result.ok) return c.json({ error: result.message }, status(result.code));
        if (syncMeta) {
            await recordGenericSyncChange(syncRepo, syncMeta, {
                op: 'message_update',
                contextId: contextPublicId,
                clientId: patchClientId,
                payload: {
                    context_id: contextPublicId,
                    version: result.data.version,
                    data: result.data.data,
                    affected_client_ids: result.data.affected_client_ids,
                },
            });
        }
        const responseBody = {
            ...result.data,
            ...(syncMeta && syncRepo
                ? { sync_base_sequence: await syncRepo.getHeadSequence(syncMeta.userId) }
                : {}),
        };
        return c.json(responseBody);
    });

    // -- delete context or messages -----------------------------------------------

    // delete — disambiguate permanent-delete vs message-delete from the body shape
    app.delete('/contexts/:id', async (c) => {
        const { projectId } = c.get('auth');
        const storage = c.get('storage');
        const contextPublicId = c.req.param('id');

        // Check Content-Type to distinguish "no body" from "JSON body"
        const contentType = c.req.header('content-type') ?? '';
        const hasJsonBody = contentType.includes('application/json');

        let body: any = null;
        if (hasJsonBody) {
            try {
                body = await c.req.json();
            } catch {
                return c.json({ error: 'Invalid JSON body' }, 400);
            }
        }

        // Permanent delete path: no body, OR explicit {permanent: true}. Any other body shape must opt
        // in explicitly to prevent typos (e.g. `{IDs:[...]}`, `{id:"x"}`) from silently wiping the context.
        const isEmptyBody = isPlainObject(body) && Object.keys(body).length === 0;
        const isExplicitPermanent = isPlainObject(body) && body.permanent === true;
        const hasIds = isPlainObject(body) && body.ids !== undefined;

        // Reject ambiguous bodies that combine both — forces the caller to pick one
        if (isExplicitPermanent && hasIds) {
            return c.json({ error: 'Cannot combine "permanent" and "ids" in the same request — pick one' }, 400);
        }

        // permanent delete — no body / {} / {permanent: true}; echo optional audit metadata
        if (!hasJsonBody || isEmptyBody || isExplicitPermanent) {
            // Optional audit metadata logged at infra level (permanent delete wipes history)
            const auditMetadata = isPlainObject(body) && isPlainObject(body.metadata) ? body.metadata : undefined;
            if (auditMetadata) {
                console.info(JSON.stringify({ op: 'permanent_delete', project_id: projectId, context_id: contextPublicId, metadata: auditMetadata }));
            }

            const result = await deleteContextPermanent(storage, projectId, contextPublicId, { auditMetadata });
            if (!result.ok) return c.json({ error: result.message }, status(result.code));
            const syncMeta = await syncSessionMeta(c, options?.authRepo);
            if (syncMeta) {
                await recordGenericSyncChange(syncRepo, syncMeta, {
                    op: 'context_delete',
                    contextId: contextPublicId,
                    payload: { context_id: contextPublicId, permanent: true, metadata: auditMetadata },
                });
            }
            return c.json(result.data);
        }

        // From here, body must have `ids` for message-delete path
        if (!isPlainObject(body)) return c.json({ error: 'Request body must be a JSON object' }, 400);
        if (!hasIds) {
            return c.json({ error: 'Body must contain "ids" (delete messages) or {"permanent": true} (delete entire context)' }, 400);
        }

        if (vaultDeps) {
            const denied = await validateVaultDeleteWrite(c, vaultDeps, body);
            if (denied) return denied;
        }

        // message delete — pass ids + optional metadata to core (core validates shapes)
        const { ids, metadata: userMetadata } = body;
        const parsedBase = parseBaseSequence(c, body);
        const idList: (string | number)[] = Array.isArray(ids) ? ids : [ids as string | number];

        const syncMeta = await syncSessionMeta(c, options?.authRepo);
        const txSyncRepo = asTransactionalSyncRepository(syncRepo);
        const deleteClientId = generateClientNodeId();

        if (syncMeta && syncRepo) {
            if (parsedBase.status === 'invalid') {
                return c.json({ error: 'Invalid base_sequence' }, 400);
            }
            if (parsedBase.status === 'missing') {
                return c.json(
                    {
                        error:
                            'base_sequence is required for message delete (use sync_base_sequence from GET /contexts/:id or your pull cursor)',
                    },
                    400,
                );
            }
        }

        if (syncMeta && txSyncRepo && parsedBase.status === 'ok') {
            const baseSequence = parsedBase.value;
            const atomic = await txSyncRepo.runStorageTransaction(async (txCtx) => {
                const headBeforeStale = await txCtx.getHeadSequence(syncMeta.userId);
                if (baseSequence > headBeforeStale) {
                    return { kind: 'invalid_base' as const };
                }
                const targets = await resolveDeleteTargetClientIds(
                    txCtx.storage,
                    projectId,
                    contextPublicId,
                    idList,
                );
                if (!targets.ok) {
                    return { kind: 'target_error' as const, targets };
                }
                const stale = await txCtx.hasMessageClientMutationSince(
                    syncMeta.userId,
                    contextPublicId,
                    baseSequence,
                    targets.data,
                );
                if (stale) {
                    const head = await txCtx.getHeadSequence(syncMeta.userId);
                    await txCtx.insertConflict({
                        userId: syncMeta.userId,
                        contextId: contextPublicId,
                        kind: 'delete_stale_base',
                        clientId: null,
                        sequence: head,
                        publicId: generateSyncConflictPublicId(),
                        leftPayload: { base_sequence: baseSequence, server_sequence: head, op: 'message_delete' },
                        rightPayload: { delete_targets: targets.data },
                    });
                    return { kind: 'stale' as const, baseSequence };
                }
                const deleteResult = await deleteMessages(
                    txCtx.storage,
                    projectId,
                    contextPublicId,
                    {
                        ids: idList,
                        userMetadata: userMetadata as Record<string, unknown> | undefined,
                    },
                    { inTransaction: true },
                );
                if (!deleteResult.ok) {
                    return { kind: 'delete_error' as const, deleteResult };
                }
                await txCtx.appendChange({
                    userId: syncMeta.userId,
                    op: 'message_delete',
                    contextId: contextPublicId,
                    clientId: deleteClientId,
                    payload: {
                        context_id: contextPublicId,
                        version: deleteResult.data.version,
                        deleted_client_ids: deleteResult.data.deleted_client_ids,
                    },
                    deviceId: syncMeta.deviceId ?? null,
                });
                const syncHead = await txCtx.getHeadSequence(syncMeta.userId);
                return { kind: 'ok' as const, deleteResult, syncHead };
            });

            if (atomic.kind === 'invalid_base') {
                return c.json({ error: 'Invalid base_sequence' }, 400);
            }
            if (atomic.kind === 'target_error') {
                return c.json({ error: atomic.targets.message }, status(atomic.targets.code));
            }
            if (atomic.kind === 'stale') {
                return c.json(
                    {
                        error: 'Delete rejected: target message changed since base_sequence',
                        conflict: 'delete_stale_base',
                        base_sequence: atomic.baseSequence,
                    },
                    409,
                );
            }
            if (atomic.kind === 'delete_error') {
                const deleteResult = atomic.deleteResult;
                return c.json({ error: deleteResult.message }, status(deleteResult.code));
            }
            return c.json({
                ...atomic.deleteResult.data,
                sync_base_sequence: atomic.syncHead,
            });
        }

        if (syncMeta && syncRepo && parsedBase.status === 'ok') {
            const baseSequence = parsedBase.value;
            const headBeforeStale = await syncRepo.getHeadSequence(syncMeta.userId);
            if (baseSequence > headBeforeStale) {
                return c.json({ error: 'Invalid base_sequence' }, 400);
            }
            const targets = await resolveDeleteTargetClientIds(storage, projectId, contextPublicId, idList);
            if (!targets.ok) return c.json({ error: targets.message }, status(targets.code));
            const stale = await assertRestMessageDeleteNotStale(
                syncRepo,
                syncMeta.userId,
                contextPublicId,
                baseSequence,
                targets.data,
            );
            if (stale) {
                const head = await syncRepo.getHeadSequence(syncMeta.userId);
                await syncRepo.insertConflict({
                    userId: syncMeta.userId,
                    contextId: contextPublicId,
                    kind: 'delete_stale_base',
                    clientId: null,
                    sequence: head,
                    publicId: generateSyncConflictPublicId(),
                    leftPayload: { base_sequence: baseSequence, server_sequence: head, op: 'message_delete' },
                    rightPayload: { delete_targets: targets.data },
                });
                return c.json(
                    {
                        error: 'Delete rejected: target message changed since base_sequence',
                        conflict: 'delete_stale_base',
                        base_sequence: baseSequence,
                    },
                    409,
                );
            }
        }

        const result = await deleteMessages(storage, projectId, contextPublicId, {
            ids: idList,
            userMetadata: userMetadata as Record<string, unknown> | undefined,
        });
        if (!result.ok) return c.json({ error: result.message }, status(result.code));
        if (syncMeta) {
            await recordGenericSyncChange(syncRepo, syncMeta, {
                op: 'message_delete',
                contextId: contextPublicId,
                clientId: deleteClientId,
                payload: {
                    context_id: contextPublicId,
                    version: result.data.version,
                    deleted_client_ids: result.data.deleted_client_ids,
                },
            });
        }
        const responseBody = {
            ...result.data,
            ...(syncMeta && syncRepo
                ? { sync_base_sequence: await syncRepo.getHeadSequence(syncMeta.userId) }
                : {}),
        };
        return c.json(responseBody);
    });
}
