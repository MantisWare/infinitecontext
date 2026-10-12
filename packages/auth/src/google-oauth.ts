export type GoogleTokenResponse = {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
    scope: string;
    token_type: string;
    id_token?: string;
};

export type GoogleDeviceStartResponse = {
    device_code: string;
    user_code: string;
    verification_url: string;
    expires_in: number;
    interval: number;
};

export type GoogleUserInfo = {
    sub: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
};

export type GoogleOAuthClient = {
    startDeviceFlow(): Promise<GoogleDeviceStartResponse>;
    pollDeviceToken(deviceCode: string): Promise<{ status: 'pending' } | { status: 'complete'; tokens: GoogleTokenResponse }>;
    buildAuthorizeUrl(input: { redirectUri: string; state: string; codeChallenge: string }): string;
    exchangeAuthorizationCode(input: {
        code: string;
        redirectUri: string;
        codeVerifier: string;
    }): Promise<GoogleTokenResponse>;
    fetchUserInfo(accessToken: string): Promise<GoogleUserInfo>;
};

const GOOGLE_DEVICE_URL = 'https://oauth2.googleapis.com/device/code';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

export function createGoogleOAuthClient(clientId: string, clientSecret: string, fetchFn: typeof fetch = fetch): GoogleOAuthClient {
    return {
        async startDeviceFlow() {
            const body = new URLSearchParams({
                client_id: clientId,
                scope: 'openid email profile',
            });
            const res = await fetchFn(GOOGLE_DEVICE_URL, { method: 'POST', body });
            if (!res.ok) {
                const text = await res.text();
                throw new Error(`Google device flow start failed: ${res.status} ${text}`);
            }
            return (await res.json()) as GoogleDeviceStartResponse;
        },

        async pollDeviceToken(deviceCode) {
            const body = new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                device_code: deviceCode,
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            });
            const res = await fetchFn(GOOGLE_TOKEN_URL, { method: 'POST', body });
            const json = (await res.json()) as GoogleTokenResponse & { error?: string };
            if (res.ok) {
                return { status: 'complete', tokens: json };
            }
            if (json.error === 'authorization_pending' || json.error === 'slow_down') {
                return { status: 'pending' };
            }
            throw new Error(`Google device poll failed: ${json.error ?? res.status}`);
        },

        buildAuthorizeUrl({ redirectUri, state, codeChallenge }) {
            const params = new URLSearchParams({
                client_id: clientId,
                redirect_uri: redirectUri,
                response_type: 'code',
                scope: 'openid email profile',
                state,
                code_challenge: codeChallenge,
                code_challenge_method: 'S256',
                access_type: 'offline',
                prompt: 'consent',
            });
            return `${GOOGLE_AUTH_URL}?${params.toString()}`;
        },

        async exchangeAuthorizationCode({ code, redirectUri, codeVerifier }) {
            const body = new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                code,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code',
                code_verifier: codeVerifier,
            });
            const res = await fetchFn(GOOGLE_TOKEN_URL, { method: 'POST', body });
            if (!res.ok) {
                const text = await res.text();
                throw new Error(`Google code exchange failed: ${res.status} ${text}`);
            }
            return (await res.json()) as GoogleTokenResponse;
        },

        async fetchUserInfo(accessToken) {
            const res = await fetchFn(GOOGLE_USERINFO_URL, {
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (!res.ok) {
                const text = await res.text();
                throw new Error(`Google userinfo failed: ${res.status} ${text}`);
            }
            return (await res.json()) as GoogleUserInfo;
        },
    };
}

export function createMockGoogleOAuthClient(overrides?: Partial<GoogleOAuthClient>): GoogleOAuthClient {
    const defaultUser: GoogleUserInfo = {
        sub: 'google-test-sub-123',
        email: 'test@example.com',
        email_verified: true,
        name: 'Test User',
    };

    return {
        async startDeviceFlow() {
            return {
                device_code: 'mock-device-code',
                user_code: 'MOCK-CODE',
                verification_url: 'https://example.com/device',
                expires_in: 600,
                interval: 2,
            };
        },
        async pollDeviceToken(deviceCode) {
            if (deviceCode !== 'mock-device-code') {
                throw new Error('unknown device code');
            }
            return {
                status: 'complete',
                tokens: {
                    access_token: 'mock-google-access',
                    expires_in: 3600,
                    token_type: 'Bearer',
                    scope: 'openid email profile',
                    id_token: 'mock-id-token',
                },
            };
        },
        buildAuthorizeUrl({ redirectUri, state, codeChallenge }) {
            const params = new URLSearchParams({ redirect_uri: redirectUri, state, code_challenge: codeChallenge });
            return `https://example.com/mock-google-auth?${params.toString()}`;
        },
        async exchangeAuthorizationCode() {
            return {
                access_token: 'mock-google-access',
                expires_in: 3600,
                token_type: 'Bearer',
                scope: 'openid email profile',
            };
        },
        async fetchUserInfo() {
            return defaultUser;
        },
        ...overrides,
    };
}
