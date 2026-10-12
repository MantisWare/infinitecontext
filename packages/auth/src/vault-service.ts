import type { AuthRepository, SessionRow, UserCryptoRow } from './types';

export class VaultService {
    constructor(private readonly authRepo: AuthRepository) {}

    async getCryptoState(userId: number): Promise<UserCryptoRow | null> {
        return this.authRepo.findUserCrypto(userId);
    }

    async initializeCrypto(input: {
        userId: number;
        kdfSalt: Buffer;
        kdfParams: Record<string, unknown>;
        wrappedDek: Buffer;
        wrappedDekRecovery: Buffer;
        dekVersion: number;
        vaultPassphraseRequired: boolean;
        now?: string;
    }): Promise<UserCryptoRow> {
        const existing = await this.authRepo.findUserCrypto(input.userId);
        if (existing?.crypto_initialized_at) {
            throw new VaultError('already_initialized', 'Vault crypto is already initialized');
        }
        const now = input.now ?? new Date().toISOString();
        return this.authRepo.upsertUserCrypto({
            userId: input.userId,
            kdfSalt: input.kdfSalt,
            kdfParams: input.kdfParams,
            wrappedDek: input.wrappedDek,
            wrappedDekRecovery: input.wrappedDekRecovery,
            dekVersion: input.dekVersion,
            cryptoInitializedAt: now,
            vaultPassphraseRequired: input.vaultPassphraseRequired,
        });
    }

    async updateWraps(input: {
        userId: number;
        wrappedDek?: Buffer;
        wrappedDekRecovery?: Buffer;
        dekVersion?: number;
    }): Promise<UserCryptoRow> {
        const existing = await this.authRepo.findUserCrypto(input.userId);
        if (!existing?.crypto_initialized_at) {
            throw new VaultError('not_initialized', 'Vault crypto is not initialized');
        }
        const updated = await this.authRepo.updateUserCryptoWraps({
            userId: input.userId,
            wrappedDek: input.wrappedDek,
            wrappedDekRecovery: input.wrappedDekRecovery,
            dekVersion: input.dekVersion,
            updatedAt: new Date().toISOString(),
        });
        if (!updated) throw new VaultError('not_initialized', 'Vault crypto is not initialized');
        return updated;
    }

    async listDevices(userId: number): Promise<SessionRow[]> {
        const sessions = await this.authRepo.listSessionsForUser(userId);
        return sessions.filter((s) => !s.revoked_at && Date.parse(s.expires_at) > Date.now());
    }

    async revokeDevice(userId: number, sessionPublicId: string): Promise<void> {
        const ok = await this.authRepo.revokeSessionByPublicId(userId, sessionPublicId, new Date().toISOString());
        if (!ok) throw new VaultError('device_not_found', 'Device session not found');
    }
}

export class VaultError extends Error {
    constructor(
        readonly code: 'already_initialized' | 'not_initialized' | 'device_not_found' | 'invalid_payload',
        message: string,
    ) {
        super(message);
        this.name = 'VaultError';
    }
}

export function serializeUserCryptoPublic(row: UserCryptoRow | null) {
    if (!row?.crypto_initialized_at) {
        return { initialized: false as const, vault_passphrase_required: Boolean(row?.vault_passphrase_required) };
    }
    return {
        initialized: true as const,
        dek_version: row.dek_version,
        kdf_params: row.kdf_params,
        kdf_salt: row.kdf_salt ? row.kdf_salt.toString('base64') : null,
        wrapped_dek: row.wrapped_dek ? row.wrapped_dek.toString('base64') : null,
        wrapped_dek_recovery: row.wrapped_dek_recovery ? row.wrapped_dek_recovery.toString('base64') : null,
        vault_passphrase_required: row.vault_passphrase_required,
        crypto_initialized_at: row.crypto_initialized_at,
    };
}
