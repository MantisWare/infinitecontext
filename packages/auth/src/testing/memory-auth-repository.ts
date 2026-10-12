import type {
    AuthRepository,
    AuthTokenRow,
    IdentityRow,
    OAuthDeviceFlowRow,
    SessionRow,
    UserRow,
} from '../types';

export class MemoryAuthRepository implements AuthRepository {
    private users: UserRow[] = [];
    private identities: IdentityRow[] = [];
    private sessions: SessionRow[] = [];
    private authTokens: AuthTokenRow[] = [];
    private deviceFlows: OAuthDeviceFlowRow[] = [];
    private userProjects = new Map<number, number>();

    private userSeq = 0;
    private identitySeq = 0;
    private sessionSeq = 0;
    private tokenSeq = 0;
    private flowSeq = 0;

    async createUser(input: {
        publicId: string;
        email: string;
        passwordHash?: string | null;
        emailVerifiedAt?: string | null;
    }): Promise<UserRow> {
        const now = new Date().toISOString();
        const row: UserRow = {
            id: ++this.userSeq,
            public_id: input.publicId,
            email: input.email,
            password_hash: input.passwordHash ?? null,
            email_verified_at: input.emailVerifiedAt ?? null,
            created_at: now,
            updated_at: now,
        };
        this.users.push(row);
        return row;
    }

    async findUserByEmail(email: string): Promise<UserRow | null> {
        return this.users.find((u) => u.email === email) ?? null;
    }

    async findUserById(id: number): Promise<UserRow | null> {
        return this.users.find((u) => u.id === id) ?? null;
    }

    async findUserByPublicId(publicId: string): Promise<UserRow | null> {
        return this.users.find((u) => u.public_id === publicId) ?? null;
    }

    async updateUserPassword(userId: number, passwordHash: string): Promise<void> {
        const user = this.users.find((u) => u.id === userId);
        if (!user) return;
        user.password_hash = passwordHash;
        user.updated_at = new Date().toISOString();
    }

    async markEmailVerified(userId: number, verifiedAt: string): Promise<void> {
        const user = this.users.find((u) => u.id === userId);
        if (!user) return;
        user.email_verified_at = verifiedAt;
        user.updated_at = verifiedAt;
    }

    async findIdentity(provider: string, providerUserId: string): Promise<IdentityRow | null> {
        return (
            this.identities.find((i) => i.provider === provider && i.provider_user_id === providerUserId) ?? null
        );
    }

    async createIdentity(input: {
        userId: number;
        provider: string;
        providerUserId: string;
        email?: string | null;
    }): Promise<IdentityRow> {
        const row: IdentityRow = {
            id: ++this.identitySeq,
            user_id: input.userId,
            provider: input.provider,
            provider_user_id: input.providerUserId,
            email: input.email ?? null,
            created_at: new Date().toISOString(),
        };
        this.identities.push(row);
        return row;
    }

    async linkUserProject(userId: number, projectId: number): Promise<void> {
        this.userProjects.set(userId, projectId);
    }

    async findProjectIdByUserId(userId: number): Promise<number | null> {
        return this.userProjects.get(userId) ?? null;
    }

    async createSession(input: {
        publicId: string;
        userId: number;
        refreshTokenHash: string;
        deviceId?: string | null;
        deviceName?: string | null;
        expiresAt: string;
    }): Promise<SessionRow> {
        const row: SessionRow = {
            id: ++this.sessionSeq,
            public_id: input.publicId,
            user_id: input.userId,
            refresh_token_hash: input.refreshTokenHash,
            replaced_refresh_token_hash: null,
            prior_replaced_refresh_token_hash: null,
            refresh_grace_expires_at: null,
            device_id: input.deviceId ?? null,
            device_name: input.deviceName ?? null,
            expires_at: input.expiresAt,
            revoked_at: null,
            created_at: new Date().toISOString(),
            last_used_at: null,
        };
        this.sessions.push(row);
        return row;
    }

    async findSessionByRefreshTokenHash(hash: string): Promise<SessionRow | null> {
        return this.sessions.find((s) => s.refresh_token_hash === hash) ?? null;
    }

    async findSessionByReplacedRefreshTokenHash(hash: string): Promise<SessionRow | null> {
        return this.sessions.find((s) => s.replaced_refresh_token_hash === hash) ?? null;
    }

    async findSessionByPriorReplacedRefreshTokenHash(hash: string): Promise<SessionRow | null> {
        return this.sessions.find((s) => s.prior_replaced_refresh_token_hash === hash) ?? null;
    }

    async findSessionById(id: number): Promise<SessionRow | null> {
        return this.sessions.find((s) => s.id === id) ?? null;
    }

    async revokeSession(id: number, revokedAt: string): Promise<void> {
        const session = this.sessions.find((s) => s.id === id);
        if (session) session.revoked_at = revokedAt;
    }

    async revokeAllSessionsForUser(userId: number, revokedAt: string): Promise<void> {
        for (const session of this.sessions) {
            if (session.user_id === userId) session.revoked_at = revokedAt;
        }
    }

    async rotateSessionRefreshToken(input: {
        sessionId: number;
        newRefreshTokenHash: string;
        previousRefreshTokenHash: string;
        lastUsedAt: string;
        refreshGraceExpiresAt: string;
    }): Promise<boolean> {
        const session = this.sessions.find((s) => s.id === input.sessionId);
        if (!session || session.refresh_token_hash !== input.previousRefreshTokenHash) return false;
        session.prior_replaced_refresh_token_hash = session.replaced_refresh_token_hash;
        session.replaced_refresh_token_hash = input.previousRefreshTokenHash;
        session.refresh_token_hash = input.newRefreshTokenHash;
        session.refresh_grace_expires_at = input.refreshGraceExpiresAt;
        session.last_used_at = input.lastUsedAt;
        return true;
    }

    async touchSession(id: number, lastUsedAt: string): Promise<void> {
        const session = this.sessions.find((s) => s.id === id);
        if (session) session.last_used_at = lastUsedAt;
    }

    async insertAuthToken(input: {
        userId: number;
        tokenHash: string;
        kind: AuthTokenRow['kind'];
        expiresAt: string;
    }): Promise<AuthTokenRow> {
        const row: AuthTokenRow = {
            id: ++this.tokenSeq,
            user_id: input.userId,
            token_hash: input.tokenHash,
            kind: input.kind,
            expires_at: input.expiresAt,
            consumed_at: null,
            created_at: new Date().toISOString(),
        };
        this.authTokens.push(row);
        return row;
    }

    async consumeAuthToken(kind: AuthTokenRow['kind'], tokenHash: string, consumedAt: string): Promise<AuthTokenRow | null> {
        const row = this.authTokens.find(
            (t) => t.kind === kind && t.token_hash === tokenHash && !t.consumed_at && Date.parse(t.expires_at) > Date.parse(consumedAt),
        );
        if (!row) return null;
        row.consumed_at = consumedAt;
        return row;
    }

    async insertOAuthDeviceFlow(input: {
        provider: string;
        deviceCodeHash: string;
        providerDeviceCode: string;
        userCode: string;
        verificationUrl: string;
        expiresAt: string;
    }): Promise<OAuthDeviceFlowRow> {
        const row: OAuthDeviceFlowRow = {
            id: ++this.flowSeq,
            provider: input.provider,
            device_code_hash: input.deviceCodeHash,
            provider_device_code: input.providerDeviceCode,
            user_code: input.userCode,
            verification_url: input.verificationUrl,
            expires_at: input.expiresAt,
            completed_at: null,
            tokens_delivered_at: null,
            user_id: null,
            created_at: new Date().toISOString(),
        };
        this.deviceFlows.push(row);
        return row;
    }

    async findOAuthDeviceFlowByHash(deviceCodeHash: string): Promise<OAuthDeviceFlowRow | null> {
        return this.deviceFlows.find((f) => f.device_code_hash === deviceCodeHash) ?? null;
    }

    async completeOAuthDeviceFlow(id: number, input: { userId: number; completedAt: string }): Promise<void> {
        const row = this.deviceFlows.find((f) => f.id === id);
        if (!row) return;
        row.completed_at = input.completedAt;
        row.user_id = input.userId;
    }

    async markOAuthDeviceFlowTokensDelivered(id: number, deliveredAt: string): Promise<boolean> {
        const row = this.deviceFlows.find((f) => f.id === id);
        if (!row || row.tokens_delivered_at) return false;
        row.tokens_delivered_at = deliveredAt;
        return true;
    }
}
