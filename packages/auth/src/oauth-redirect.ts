const LOCALHOST_CALLBACK = /^http:\/\/127\.0\.0\.1:\d+\/callback$/;

export function isAllowedOAuthRedirectUri(redirectUri: string): boolean {
    const trimmed = String(redirectUri ?? '').trim();
    if (!trimmed) return false;
    try {
        const url = new URL(trimmed);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return false;
        if (url.pathname !== '/callback') return false;
        if (url.search || url.hash) return false;
        return LOCALHOST_CALLBACK.test(trimmed);
    } catch {
        return false;
    }
}
