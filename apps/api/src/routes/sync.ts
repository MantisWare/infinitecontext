import { SyncService, SyncApplyError, SyncValidationError } from '@infinitecontext/core/sync';
import type { SyncRepository } from '@infinitecontext/core/sync';
import type { AuthRepository } from '@infinitecontext/auth';
import type { StorageAdapter } from '@infinitecontext/core';

import { enforceSyncRateLimit, type SyncRateLimiters } from '../sync/rate-limit';
import { validateVaultSyncPush, type VaultEncryptionDeps } from '../sync/vault-validate';
import type { HttpApp, HttpContext } from '../types/http';

export type SyncRouteDeps = {
    syncRepo: SyncRepository | null;
    authRepo: AuthRepository | null;
    rateLimiters: SyncRateLimiters;
};

function requireUserSession(c: HttpContext) {
    const auth = c.get('auth');
    if (auth.kind !== 'user_session') return null;
    return auth;
}

function mapPushError(error: unknown, c: HttpContext) {
    if (error instanceof SyncValidationError) {
        return c.json({ error: error.message }, 400);
    }
    if (error instanceof SyncApplyError) {
        const status = error.code === 'not_found' ? 404 : error.code === 'invalid_input' ? 400 : 409;
        return c.json({ error: error.message, code: error.code }, status);
    }
    return c.json({ error: 'Internal error' }, 500);
}

export function registerSyncRoutes(app: HttpApp, deps: SyncRouteDeps) {
    app.get('/sync/status', async (c) => {
        const auth = requireUserSession(c);
        if (!auth) return c.json({ error: 'Sync API requires account session' }, 403);
        if (!deps.syncRepo) return c.json({ error: 'Sync API unavailable for this storage backend' }, 503);

        const limited = enforceSyncRateLimit(deps.rateLimiters.pullByUser, auth.userId);
        if (!limited.allowed) {
            c.header('Retry-After', String(limited.retryAfterSec));
            return c.json({ error: 'Rate limit exceeded' }, 429);
        }

        const service = new SyncService(c.get('storage'), deps.syncRepo);
        const status = await service.getStatus(auth.userId);
        return c.json(status);
    });

    app.get('/sync/changes', async (c) => {
        const auth = requireUserSession(c);
        if (!auth) return c.json({ error: 'Sync API requires account session' }, 403);
        if (!deps.syncRepo) return c.json({ error: 'Sync API unavailable for this storage backend' }, 503);

        const limited = enforceSyncRateLimit(deps.rateLimiters.pullByUser, auth.userId);
        if (!limited.allowed) {
            c.header('Retry-After', String(limited.retryAfterSec));
            return c.json({ error: 'Rate limit exceeded' }, 429);
        }

        const since = Number(c.req.query('since') ?? 0);
        const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;
        const service = new SyncService(c.get('storage'), deps.syncRepo);
        const result = await service.pullChanges(auth.userId, since, limit);
        return c.json(result);
    });

    app.get('/sync/conflicts', async (c) => {
        const auth = requireUserSession(c);
        if (!auth) return c.json({ error: 'Sync API requires account session' }, 403);
        if (!deps.syncRepo) return c.json({ error: 'Sync API unavailable for this storage backend' }, 503);

        const since = Number(c.req.query('since') ?? 0);
        const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 200;
        const rows = await deps.syncRepo.listConflictsSince(auth.userId, since, limit);
        return c.json({ data: rows });
    });

    app.post('/sync/push', async (c) => {
        const auth = requireUserSession(c);
        if (!auth) return c.json({ error: 'Sync API requires account session' }, 403);
        if (!deps.syncRepo || !deps.authRepo) {
            return c.json({ error: 'Sync API unavailable for this storage backend' }, 503);
        }

        const limited = enforceSyncRateLimit(deps.rateLimiters.pushByUser, auth.userId);
        if (!limited.allowed) {
            c.header('Retry-After', String(limited.retryAfterSec));
            return c.json({ error: 'Rate limit exceeded' }, 429);
        }

        const body = await c.req.json().catch(() => null);
        if (!body || typeof body !== 'object') return c.json({ error: 'Invalid JSON body' }, 400);

        const mutations = (body as { mutations?: unknown }).mutations;
        const vaultDeps: VaultEncryptionDeps = { authRepo: deps.authRepo };
        const denied = await validateVaultSyncPush(
            c,
            vaultDeps,
            c.get('storage') as StorageAdapter,
            auth.projectId,
            Array.isArray(mutations) ? (mutations as any[]) : [],
        );
        if (denied) return denied;

        const session = await deps.authRepo.findSessionById(auth.sessionId);
        const service = new SyncService(c.get('storage'), deps.syncRepo);
        try {
            const result = await service.pushMutations(
                {
                    userId: auth.userId,
                    projectId: auth.projectId,
                    sessionId: auth.sessionId,
                    deviceId: session?.device_id ?? null,
                },
                Array.isArray(mutations) ? mutations : [],
            );
            return c.json(result);
        } catch (error) {
            return mapPushError(error, c);
        }
    });
}
