export type UserRow = {
    id: number;
    public_id: string;
    email: string;
    password_hash: string | null;
    email_verified_at: string | null;
    created_at: string;
    updated_at: string;
};

export type IdentityRow = {
    id: number;
    user_id: number;
    provider: string;
    provider_user_id: string;
    email: string | null;
    created_at: string;
};

export type SessionRow = {
    id: number;
    public_id: string;
    user_id: number;
    refresh_token_hash: string;
    replaced_refresh_token_hash: string | null;
    prior_replaced_refresh_token_hash: string | null;
    refresh_grace_expires_at: string | null;
    device_id: string | null;
    device_name: string | null;
    expires_at: string;
    revoked_at: string | null;
    created_at: string;
    last_used_at: string | null;
};

export type AuthTokenRow = {
    id: number;
    user_id: number;
    token_hash: string;
    kind: 'email_verify' | 'password_reset';
    expires_at: string;
    consumed_at: string | null;
    created_at: string;
};

export type UserCryptoRow = {
    user_id: number;
    kdf_salt: Buffer | null;
    kdf_params: Record<string, unknown> | null;
    wrapped_dek: Buffer | null;
    wrapped_dek_recovery: Buffer | null;
    recovery_kdf_salt: Buffer | null;
    dek_version: number;
    crypto_initialized_at: string | null;
    vault_passphrase_required: boolean;
    created_at: string;
    updated_at: string;
};

export type OAuthDeviceFlowRow = {
    id: number;
    provider: string;
    device_code_hash: string;
    provider_device_code: string;
    user_code: string;
    verification_url: string;
    expires_at: string;
    completed_at: string | null;
    tokens_delivered_at: string | null;
    user_id: number | null;
    created_at: string;
};

export type AuthRepository = {
    createUser(input: {
        publicId: string;
        email: string;
        passwordHash?: string | null;
        emailVerifiedAt?: string | null;
    }): Promise<UserRow>;

    findUserByEmail(email: string): Promise<UserRow | null>;
    findUserById(id: number): Promise<UserRow | null>;
    findUserByPublicId(publicId: string): Promise<UserRow | null>;
    updateUserPassword(userId: number, passwordHash: string): Promise<void>;
    markEmailVerified(userId: number, verifiedAt: string): Promise<void>;

    findIdentity(provider: string, providerUserId: string): Promise<IdentityRow | null>;
    createIdentity(input: {
        userId: number;
        provider: string;
        providerUserId: string;
        email?: string | null;
    }): Promise<IdentityRow>;

    linkUserProject(userId: number, projectId: number): Promise<void>;
    findProjectIdByUserId(userId: number): Promise<number | null>;

    createSession(input: {
        publicId: string;
        userId: number;
        refreshTokenHash: string;
        deviceId?: string | null;
        deviceName?: string | null;
        expiresAt: string;
    }): Promise<SessionRow>;

    findSessionByRefreshTokenHash(hash: string): Promise<SessionRow | null>;
    findSessionByReplacedRefreshTokenHash(hash: string): Promise<SessionRow | null>;
    findSessionByPriorReplacedRefreshTokenHash(hash: string): Promise<SessionRow | null>;
    findSessionById(id: number): Promise<SessionRow | null>;
    revokeSession(id: number, revokedAt: string): Promise<void>;
    revokeAllSessionsForUser(userId: number, revokedAt: string): Promise<void>;
    rotateSessionRefreshToken(input: {
        sessionId: number;
        newRefreshTokenHash: string;
        previousRefreshTokenHash: string;
        lastUsedAt: string;
        refreshGraceExpiresAt: string;
    }): Promise<boolean>;
    touchSession(id: number, lastUsedAt: string): Promise<void>;

    insertAuthToken(input: {
        userId: number;
        tokenHash: string;
        kind: AuthTokenRow['kind'];
        expiresAt: string;
    }): Promise<AuthTokenRow>;

    consumeAuthToken(kind: AuthTokenRow['kind'], tokenHash: string, consumedAt: string): Promise<AuthTokenRow | null>;

    insertOAuthDeviceFlow(input: {
        provider: string;
        deviceCodeHash: string;
        providerDeviceCode: string;
        userCode: string;
        verificationUrl: string;
        expiresAt: string;
    }): Promise<OAuthDeviceFlowRow>;

    findOAuthDeviceFlowByHash(deviceCodeHash: string): Promise<OAuthDeviceFlowRow | null>;
    completeOAuthDeviceFlow(id: number, input: { userId: number; completedAt: string }): Promise<void>;
    markOAuthDeviceFlowTokensDelivered(id: number, deliveredAt: string): Promise<boolean>;

    findUserCrypto(userId: number): Promise<UserCryptoRow | null>;
    ensureVaultPassphraseRequired(userId: number): Promise<void>;
    upsertUserCrypto(input: {
        userId: number;
        kdfSalt: Buffer;
        kdfParams: Record<string, unknown>;
        wrappedDek: Buffer;
        wrappedDekRecovery: Buffer;
        dekVersion: number;
        cryptoInitializedAt: string;
        vaultPassphraseRequired: boolean;
    }): Promise<UserCryptoRow>;
    updateUserCryptoWraps(input: {
        userId: number;
        wrappedDek?: Buffer;
        wrappedDekRecovery?: Buffer;
        dekVersion?: number;
        updatedAt: string;
    }): Promise<UserCryptoRow | null>;

    listSessionsForUser(userId: number): Promise<SessionRow[]>;
    revokeSessionByPublicId(userId: number, sessionPublicId: string, revokedAt: string): Promise<boolean>;
};

export type AuthTokenPair = {
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt: string;
    refreshTokenExpiresAt: string;
    tokenType: 'Bearer';
};

export type AccessTokenClaims = {
    sub: string;
    uid: number;
    pid: number;
    sid: number;
    typ: 'access';
};

export type AuthRuntimeConfig = {
    jwtSecret: string;
    jwtIssuer: string;
    jwtAudience: string;
    accessTokenTtlSec: number;
    refreshTokenTtlSec: number;
    publicBaseUrl: string;
    googleClientId?: string;
    googleClientSecret?: string;
};

export type Mailer = {
    sendVerificationEmail(input: { to: string; verifyUrl: string }): Promise<void>;
    sendPasswordResetEmail(input: { to: string; resetUrl: string }): Promise<void>;
};
