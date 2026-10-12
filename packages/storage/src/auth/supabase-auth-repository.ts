import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type {
    AuthRepository,
    AuthTokenRow,
    IdentityRow,
    OAuthDeviceFlowRow,
    SessionRow,
    UserRow,
} from '@infinitecontext/auth';

export class SupabaseAuthRepository implements AuthRepository {
    private client: SupabaseClient;

    constructor(url: string, serviceRoleKey: string) {
        this.client = createClient(url, serviceRoleKey);
    }

    async createUser(input: {
        publicId: string;
        email: string;
        passwordHash?: string | null;
        emailVerifiedAt?: string | null;
    }): Promise<UserRow> {
        const { data, error } = await this.client
            .from('users')
            .insert({
                public_id: input.publicId,
                email: input.email,
                password_hash: input.passwordHash ?? null,
                email_verified_at: input.emailVerifiedAt ?? null,
            })
            .select()
            .single();
        if (error) throw error;
        return data as UserRow;
    }

    async findUserByEmail(email: string): Promise<UserRow | null> {
        const { data, error } = await this.client.from('users').select().eq('email', email).maybeSingle();
        if (error) throw error;
        return (data as UserRow) ?? null;
    }

    async findUserById(id: number): Promise<UserRow | null> {
        const { data, error } = await this.client.from('users').select().eq('id', id).maybeSingle();
        if (error) throw error;
        return (data as UserRow) ?? null;
    }

    async findUserByPublicId(publicId: string): Promise<UserRow | null> {
        const { data, error } = await this.client.from('users').select().eq('public_id', publicId).maybeSingle();
        if (error) throw error;
        return (data as UserRow) ?? null;
    }

    async updateUserPassword(userId: number, passwordHash: string): Promise<void> {
        const { error } = await this.client
            .from('users')
            .update({ password_hash: passwordHash, updated_at: new Date().toISOString() })
            .eq('id', userId);
        if (error) throw error;
    }

    async markEmailVerified(userId: number, verifiedAt: string): Promise<void> {
        const { error } = await this.client
            .from('users')
            .update({ email_verified_at: verifiedAt, updated_at: verifiedAt })
            .eq('id', userId);
        if (error) throw error;
    }

    async findIdentity(provider: string, providerUserId: string): Promise<IdentityRow | null> {
        const { data, error } = await this.client
            .from('identities')
            .select()
            .eq('provider', provider)
            .eq('provider_user_id', providerUserId)
            .maybeSingle();
        if (error) throw error;
        return (data as IdentityRow) ?? null;
    }

    async createIdentity(input: {
        userId: number;
        provider: string;
        providerUserId: string;
        email?: string | null;
    }): Promise<IdentityRow> {
        const { data, error } = await this.client
            .from('identities')
            .insert({
                user_id: input.userId,
                provider: input.provider,
                provider_user_id: input.providerUserId,
                email: input.email ?? null,
            })
            .select()
            .single();
        if (error) throw error;
        return data as IdentityRow;
    }

    async linkUserProject(userId: number, projectId: number): Promise<void> {
        const { error } = await this.client.from('user_projects').insert({ user_id: userId, project_id: projectId });
        if (error) throw error;
    }

    async findProjectIdByUserId(userId: number): Promise<number | null> {
        const { data, error } = await this.client.from('user_projects').select('project_id').eq('user_id', userId).maybeSingle();
        if (error) throw error;
        return data?.project_id ?? null;
    }

    async createSession(input: {
        publicId: string;
        userId: number;
        refreshTokenHash: string;
        deviceId?: string | null;
        deviceName?: string | null;
        expiresAt: string;
    }): Promise<SessionRow> {
        const { data, error } = await this.client
            .from('sessions')
            .insert({
                public_id: input.publicId,
                user_id: input.userId,
                refresh_token_hash: input.refreshTokenHash,
                device_id: input.deviceId ?? null,
                device_name: input.deviceName ?? null,
                expires_at: input.expiresAt,
            })
            .select()
            .single();
        if (error) throw error;
        return data as SessionRow;
    }

    async findSessionByRefreshTokenHash(hash: string): Promise<SessionRow | null> {
        const { data, error } = await this.client.from('sessions').select().eq('refresh_token_hash', hash).maybeSingle();
        if (error) throw error;
        return (data as SessionRow) ?? null;
    }

    async findSessionByReplacedRefreshTokenHash(hash: string): Promise<SessionRow | null> {
        const { data, error } = await this.client
            .from('sessions')
            .select()
            .eq('replaced_refresh_token_hash', hash)
            .maybeSingle();
        if (error) throw error;
        return (data as SessionRow) ?? null;
    }

    async findSessionByPriorReplacedRefreshTokenHash(hash: string): Promise<SessionRow | null> {
        const { data, error } = await this.client
            .from('sessions')
            .select()
            .eq('prior_replaced_refresh_token_hash', hash)
            .maybeSingle();
        if (error) throw error;
        return (data as SessionRow) ?? null;
    }

    async findSessionById(id: number): Promise<SessionRow | null> {
        const { data, error } = await this.client.from('sessions').select().eq('id', id).maybeSingle();
        if (error) throw error;
        return (data as SessionRow) ?? null;
    }

    async revokeSession(id: number, revokedAt: string): Promise<void> {
        const { error } = await this.client.from('sessions').update({ revoked_at: revokedAt }).eq('id', id);
        if (error) throw error;
    }

    async revokeAllSessionsForUser(userId: number, revokedAt: string): Promise<void> {
        const { error } = await this.client.from('sessions').update({ revoked_at: revokedAt }).eq('user_id', userId);
        if (error) throw error;
    }

    async rotateSessionRefreshToken(input: {
        sessionId: number;
        newRefreshTokenHash: string;
        previousRefreshTokenHash: string;
        lastUsedAt: string;
        refreshGraceExpiresAt: string;
    }): Promise<boolean> {
        const current = await this.findSessionById(input.sessionId);
        if (!current || current.refresh_token_hash !== input.previousRefreshTokenHash) return false;

        const { data, error } = await this.client
            .from('sessions')
            .update({
                refresh_token_hash: input.newRefreshTokenHash,
                prior_replaced_refresh_token_hash: current.replaced_refresh_token_hash,
                replaced_refresh_token_hash: input.previousRefreshTokenHash,
                refresh_grace_expires_at: input.refreshGraceExpiresAt,
                last_used_at: input.lastUsedAt,
            })
            .eq('id', input.sessionId)
            .eq('refresh_token_hash', input.previousRefreshTokenHash)
            .select('id');
        if (error) throw error;
        return (data?.length ?? 0) > 0;
    }

    async touchSession(id: number, lastUsedAt: string): Promise<void> {
        const { error } = await this.client.from('sessions').update({ last_used_at: lastUsedAt }).eq('id', id);
        if (error) throw error;
    }

    async insertAuthToken(input: {
        userId: number;
        tokenHash: string;
        kind: AuthTokenRow['kind'];
        expiresAt: string;
    }): Promise<AuthTokenRow> {
        const { data, error } = await this.client
            .from('auth_tokens')
            .insert({
                user_id: input.userId,
                token_hash: input.tokenHash,
                kind: input.kind,
                expires_at: input.expiresAt,
            })
            .select()
            .single();
        if (error) throw error;
        return data as AuthTokenRow;
    }

    async consumeAuthToken(kind: AuthTokenRow['kind'], tokenHash: string, consumedAt: string): Promise<AuthTokenRow | null> {
        const { data, error } = await this.client
            .from('auth_tokens')
            .select()
            .eq('kind', kind)
            .eq('token_hash', tokenHash)
            .is('consumed_at', null)
            .gt('expires_at', consumedAt)
            .maybeSingle();
        if (error) throw error;
        if (!data) return null;
        const { error: updateError } = await this.client.from('auth_tokens').update({ consumed_at: consumedAt }).eq('id', data.id);
        if (updateError) throw updateError;
        return data as AuthTokenRow;
    }

    async insertOAuthDeviceFlow(input: {
        provider: string;
        deviceCodeHash: string;
        providerDeviceCode: string;
        userCode: string;
        verificationUrl: string;
        expiresAt: string;
    }): Promise<OAuthDeviceFlowRow> {
        const { data, error } = await this.client
            .from('oauth_device_flows')
            .insert({
                provider: input.provider,
                device_code_hash: input.deviceCodeHash,
                provider_device_code: input.providerDeviceCode,
                user_code: input.userCode,
                verification_url: input.verificationUrl,
                expires_at: input.expiresAt,
            })
            .select()
            .single();
        if (error) throw error;
        return data as OAuthDeviceFlowRow;
    }

    async findOAuthDeviceFlowByHash(deviceCodeHash: string): Promise<OAuthDeviceFlowRow | null> {
        const { data, error } = await this.client
            .from('oauth_device_flows')
            .select()
            .eq('device_code_hash', deviceCodeHash)
            .maybeSingle();
        if (error) throw error;
        return (data as OAuthDeviceFlowRow) ?? null;
    }

    async completeOAuthDeviceFlow(id: number, input: { userId: number; completedAt: string }): Promise<void> {
        const { error } = await this.client
            .from('oauth_device_flows')
            .update({
                completed_at: input.completedAt,
                user_id: input.userId,
            })
            .eq('id', id);
        if (error) throw error;
    }

    async markOAuthDeviceFlowTokensDelivered(id: number, deliveredAt: string): Promise<boolean> {
        const { data, error } = await this.client
            .from('oauth_device_flows')
            .update({ tokens_delivered_at: deliveredAt })
            .eq('id', id)
            .is('tokens_delivered_at', null)
            .select('id');
        if (error) throw error;
        return (data?.length ?? 0) > 0;
    }
}
