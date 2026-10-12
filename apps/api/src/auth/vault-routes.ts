import { VaultError, VaultService, serializeUserCryptoPublic } from '@infinitecontext/auth';
import type { AuthRepository } from '@infinitecontext/auth';

import type { HttpApp, HttpContext } from '../types/http';

function requireUserSession(c: HttpContext) {
    const auth = c.get('auth');
    if (auth.kind !== 'user_session') return null;
    return auth;
}

function mapVaultError(error: unknown): { status: 400 | 404 | 409 | 500; message: string } {
    if (error instanceof VaultError) {
        const status: 400 | 404 | 409 =
            error.code === 'already_initialized'
                ? 409
                : error.code === 'not_initialized' || error.code === 'device_not_found'
                  ? 404
                  : 400;
        return { status, message: error.message };
    }
    return { status: 500, message: 'Internal error' };
}

function readBufferField(body: Record<string, unknown>, field: string): Buffer | undefined {
    const raw = body[field];
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== 'string') throw new VaultError('invalid_payload', `Invalid ${field}`);
    return Buffer.from(raw, 'base64');
}

export function registerVaultRoutes(app: HttpApp, authRepo: AuthRepository) {
    const vault = new VaultService(authRepo);

    app.get('/auth/crypto', async (c) => {
        const auth = requireUserSession(c);
        if (!auth) return c.json({ error: 'Unauthorized' }, 401);
        const row = await vault.getCryptoState(auth.userId);
        return c.json(serializeUserCryptoPublic(row));
    });

    app.put('/auth/crypto', async (c) => {
        const auth = requireUserSession(c);
        if (!auth) return c.json({ error: 'Unauthorized' }, 401);
        const body = await c.req.json().catch(() => ({}));
        try {
            const kdfSalt = readBufferField(body as Record<string, unknown>, 'kdf_salt');
            const wrappedDek = readBufferField(body as Record<string, unknown>, 'wrapped_dek');
            const wrappedDekRecovery = readBufferField(body as Record<string, unknown>, 'wrapped_dek_recovery');
            if (!kdfSalt || !wrappedDek || !wrappedDekRecovery) {
                throw new VaultError('invalid_payload', 'Missing required crypto fields');
            }
            const kdfParams = (body as Record<string, unknown>).kdf_params;
            if (!kdfParams || typeof kdfParams !== 'object') {
                throw new VaultError('invalid_payload', 'Missing kdf_params');
            }
            const dekVersion = Number((body as Record<string, unknown>).dek_version ?? 1);
            const vaultPassphraseRequired = Boolean((body as Record<string, unknown>).vault_passphrase_required);

            const row = await vault.initializeCrypto({
                userId: auth.userId,
                kdfSalt,
                kdfParams: kdfParams as Record<string, unknown>,
                wrappedDek,
                wrappedDekRecovery,
                dekVersion,
                vaultPassphraseRequired,
            });
            return c.json(serializeUserCryptoPublic(row));
        } catch (error) {
            const mapped = mapVaultError(error);
            return c.json({ error: mapped.message }, mapped.status);
        }
    });

    app.patch('/auth/crypto', async (c) => {
        const auth = requireUserSession(c);
        if (!auth) return c.json({ error: 'Unauthorized' }, 401);
        const body = await c.req.json().catch(() => ({}));
        try {
            const wrappedDek = readBufferField(body as Record<string, unknown>, 'wrapped_dek');
            const wrappedDekRecovery = readBufferField(body as Record<string, unknown>, 'wrapped_dek_recovery');
            const dekVersionRaw = (body as Record<string, unknown>).dek_version;
            const dekVersion = dekVersionRaw === undefined ? undefined : Number(dekVersionRaw);
            if (!wrappedDek && !wrappedDekRecovery && dekVersion === undefined) {
                throw new VaultError('invalid_payload', 'No crypto fields to update');
            }
            const row = await vault.updateWraps({
                userId: auth.userId,
                wrappedDek,
                wrappedDekRecovery,
                dekVersion,
            });
            return c.json(serializeUserCryptoPublic(row));
        } catch (error) {
            const mapped = mapVaultError(error);
            return c.json({ error: mapped.message }, mapped.status);
        }
    });

    app.get('/auth/devices', async (c) => {
        const auth = requireUserSession(c);
        if (!auth) return c.json({ error: 'Unauthorized' }, 401);
        const devices = await vault.listDevices(auth.userId);
        return c.json({
            data: devices.map((d) => ({
                id: d.public_id,
                device_id: d.device_id,
                device_name: d.device_name,
                created_at: d.created_at,
                last_used_at: d.last_used_at,
                expires_at: d.expires_at,
                current: d.id === auth.sessionId,
            })),
        });
    });

    app.post('/auth/devices/:sessionPublicId/revoke', async (c) => {
        const auth = requireUserSession(c);
        if (!auth) return c.json({ error: 'Unauthorized' }, 401);
        const sessionPublicId = c.req.param('sessionPublicId');
        try {
            await vault.revokeDevice(auth.userId, sessionPublicId);
            return c.json({ ok: true });
        } catch (error) {
            const mapped = mapVaultError(error);
            return c.json({ error: mapped.message }, mapped.status);
        }
    });
}
