import { and, eq, gt, isNull } from 'drizzle-orm';

import type {
    AuthRepository,
    AuthTokenRow,
    IdentityRow,
    OAuthDeviceFlowRow,
    OAuthStateRow,
    SessionRow,
    UserRow,
} from '@infinitecontext/auth';

import {
    auth_tokens,
    identities,
    oauth_device_flows,
    oauth_states,
    sessions,
    user_projects,
    users,
    type ApiDb,
} from '../db';

export class DrizzleAuthRepository implements AuthRepository {
    constructor(private readonly db: ApiDb) {}

    async createUser(input: {
        publicId: string;
        email: string;
        passwordHash?: string | null;
        emailVerifiedAt?: string | null;
    }): Promise<UserRow> {
        const rows = await this.db
            .insert(users)
            .values({
                public_id: input.publicId,
                email: input.email,
                password_hash: input.passwordHash ?? null,
                email_verified_at: input.emailVerifiedAt ?? null,
            })
            .returning();
        return rows[0] as UserRow;
    }

    async findUserByEmail(email: string): Promise<UserRow | null> {
        const rows = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
        return (rows[0] as UserRow) ?? null;
    }

    async findUserById(id: number): Promise<UserRow | null> {
        const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
        return (rows[0] as UserRow) ?? null;
    }

    async findUserByPublicId(publicId: string): Promise<UserRow | null> {
        const rows = await this.db.select().from(users).where(eq(users.public_id, publicId)).limit(1);
        return (rows[0] as UserRow) ?? null;
    }

    async updateUserPassword(userId: number, passwordHash: string): Promise<void> {
        await this.db
            .update(users)
            .set({ password_hash: passwordHash, updated_at: new Date().toISOString() })
            .where(eq(users.id, userId));
    }

    async markEmailVerified(userId: number, verifiedAt: string): Promise<void> {
        await this.db
            .update(users)
            .set({ email_verified_at: verifiedAt, updated_at: verifiedAt })
            .where(eq(users.id, userId));
    }

    async findIdentity(provider: string, providerUserId: string): Promise<IdentityRow | null> {
        const rows = await this.db
            .select()
            .from(identities)
            .where(and(eq(identities.provider, provider), eq(identities.provider_user_id, providerUserId)))
            .limit(1);
        return (rows[0] as IdentityRow) ?? null;
    }

    async createIdentity(input: {
        userId: number;
        provider: string;
        providerUserId: string;
        email?: string | null;
    }): Promise<IdentityRow> {
        const rows = await this.db
            .insert(identities)
            .values({
                user_id: input.userId,
                provider: input.provider,
                provider_user_id: input.providerUserId,
                email: input.email ?? null,
            })
            .returning();
        return rows[0] as IdentityRow;
    }

    async linkUserProject(userId: number, projectId: number): Promise<void> {
        await this.db.insert(user_projects).values({ user_id: userId, project_id: projectId });
    }

    async findProjectIdByUserId(userId: number): Promise<number | null> {
        const rows = await this.db.select().from(user_projects).where(eq(user_projects.user_id, userId)).limit(1);
        return rows[0]?.project_id ?? null;
    }

    async createSession(input: {
        publicId: string;
        userId: number;
        refreshTokenHash: string;
        deviceId?: string | null;
        deviceName?: string | null;
        expiresAt: string;
    }): Promise<SessionRow> {
        const rows = await this.db
            .insert(sessions)
            .values({
                public_id: input.publicId,
                user_id: input.userId,
                refresh_token_hash: input.refreshTokenHash,
                device_id: input.deviceId ?? null,
                device_name: input.deviceName ?? null,
                expires_at: input.expiresAt,
            })
            .returning();
        return rows[0] as SessionRow;
    }

    async findSessionByRefreshTokenHash(hash: string): Promise<SessionRow | null> {
        const rows = await this.db.select().from(sessions).where(eq(sessions.refresh_token_hash, hash)).limit(1);
        return (rows[0] as SessionRow) ?? null;
    }

    async findSessionById(id: number): Promise<SessionRow | null> {
        const rows = await this.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
        return (rows[0] as SessionRow) ?? null;
    }

    async revokeSession(id: number, revokedAt: string): Promise<void> {
        await this.db.update(sessions).set({ revoked_at: revokedAt }).where(eq(sessions.id, id));
    }

    async touchSession(id: number, lastUsedAt: string): Promise<void> {
        await this.db.update(sessions).set({ last_used_at: lastUsedAt }).where(eq(sessions.id, id));
    }

    async insertAuthToken(input: {
        userId: number;
        tokenHash: string;
        kind: AuthTokenRow['kind'];
        expiresAt: string;
    }): Promise<AuthTokenRow> {
        const rows = await this.db
            .insert(auth_tokens)
            .values({
                user_id: input.userId,
                token_hash: input.tokenHash,
                kind: input.kind,
                expires_at: input.expiresAt,
            })
            .returning();
        return rows[0] as AuthTokenRow;
    }

    async consumeAuthToken(kind: AuthTokenRow['kind'], tokenHash: string, consumedAt: string): Promise<AuthTokenRow | null> {
        const rows = await this.db
            .select()
            .from(auth_tokens)
            .where(
                and(
                    eq(auth_tokens.kind, kind),
                    eq(auth_tokens.token_hash, tokenHash),
                    isNull(auth_tokens.consumed_at),
                    gt(auth_tokens.expires_at, consumedAt),
                ),
            )
            .limit(1);
        const row = rows[0] as AuthTokenRow | undefined;
        if (!row) return null;
        await this.db.update(auth_tokens).set({ consumed_at: consumedAt }).where(eq(auth_tokens.id, row.id));
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
        const rows = await this.db
            .insert(oauth_device_flows)
            .values({
                provider: input.provider,
                device_code_hash: input.deviceCodeHash,
                provider_device_code: input.providerDeviceCode,
                user_code: input.userCode,
                verification_url: input.verificationUrl,
                expires_at: input.expiresAt,
            })
            .returning();
        return rows[0] as OAuthDeviceFlowRow;
    }

    async findOAuthDeviceFlowByHash(deviceCodeHash: string): Promise<OAuthDeviceFlowRow | null> {
        const rows = await this.db
            .select()
            .from(oauth_device_flows)
            .where(eq(oauth_device_flows.device_code_hash, deviceCodeHash))
            .limit(1);
        return (rows[0] as OAuthDeviceFlowRow) ?? null;
    }

    async completeOAuthDeviceFlow(id: number, input: { userId: number; sessionBundle: Record<string, unknown> }): Promise<void> {
        await this.db
            .update(oauth_device_flows)
            .set({
                completed_at: new Date().toISOString(),
                user_id: input.userId,
                session_bundle: input.sessionBundle,
            })
            .where(eq(oauth_device_flows.id, id));
    }

    async insertOAuthState(input: OAuthStateRow): Promise<void> {
        await this.db.insert(oauth_states).values(input);
    }

    async consumeOAuthState(stateHash: string, now: string): Promise<OAuthStateRow | null> {
        const rows = await this.db
            .select()
            .from(oauth_states)
            .where(and(eq(oauth_states.state_hash, stateHash), gt(oauth_states.expires_at, now)))
            .limit(1);
        const row = rows[0] as OAuthStateRow | undefined;
        if (!row) return null;
        await this.db.delete(oauth_states).where(eq(oauth_states.state_hash, stateHash));
        return row;
    }
}
