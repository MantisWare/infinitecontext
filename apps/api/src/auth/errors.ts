import { AuthError } from '@infinitecontext/auth';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export function authErrorStatus(code: string): ContentfulStatusCode {
    switch (code) {
        case 'invalid_email':
        case 'weak_password':
            return 400;
        case 'invalid_credentials':
            return 401;
        case 'registration_failed':
            return 400;
        case 'rate_limited':
            return 429;
        case 'invalid_refresh':
        case 'invalid_token':
        case 'invalid_device_code':
            return 401;
        case 'google_not_configured':
            return 503;
        default:
            return 400;
    }
}

export function mapAuthError(error: unknown): { status: ContentfulStatusCode; message: string } {
    if (error instanceof AuthError) {
        return { status: authErrorStatus(error.code), message: error.message };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { status: 500, message };
}
