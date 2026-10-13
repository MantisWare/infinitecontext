import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import type { AppEnv } from '../types/http';

export function jsonError(
    c: Context<AppEnv>,
    status: ContentfulStatusCode,
    input: { error: string; code: string; [key: string]: unknown },
    headers?: Record<string, string>,
) {
    if (headers) {
        for (const [key, value] of Object.entries(headers)) {
            c.header(key, value);
        }
    }
    return c.json(input, status);
}

export const RETRY_AFTER_CONFLICT = '1';
export const RETRY_AFTER_UNAVAILABLE = '5';
