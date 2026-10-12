import { buildAuthRuntimeConfig } from '@infinitecontext/auth';
import { KEYS_AND_SERVICES_DOC_URL } from '@infinitecontext/core/doc-urls';

import { resolveMailer } from './auth/mailer';

export { KEYS_AND_SERVICES_DOC_URL };

export class MissingConfigError extends Error {
    readonly envVar: string;

    constructor(envVar: string, detail?: string) {
        const suffix = detail ? ` ${detail}` : '';
        super(
            `Missing required configuration: ${envVar}.${suffix} See ${KEYS_AND_SERVICES_DOC_URL}`,
        );
        this.name = 'MissingConfigError';
        this.envVar = envVar;
    }
}

export function requireEnv(env: Record<string, string | undefined>, name: string): string {
    const value = String(env[name] ?? '').trim();
    if (!value) throw new MissingConfigError(name);
    return value;
}

export type HealthConfigBooleans = {
    database: boolean;
    account_auth: boolean;
    google_oauth: boolean;
    smtp_mail: boolean;
    resend_mail: boolean;
    console_mail: boolean;
    kv_key_cache: boolean;
};

export function buildHealthConfigBooleans(
    env: Record<string, string | undefined>,
    options?: { kvBound?: boolean },
): HealthConfigBooleans {
    const authConfig = buildAuthRuntimeConfig(env);
    const mailProvider = String(env.INFINITECONTEXT_MAIL_PROVIDER ?? 'smtp').trim().toLowerCase();
    const nodeEnv = String(env.NODE_ENV ?? '').trim().toLowerCase();
    const icEnv = String(env.INFINITECONTEXT_ENV ?? '').trim().toLowerCase();
    const devLike = nodeEnv === 'development' || nodeEnv === 'test' || icEnv === 'development' || icEnv === 'test';
    const consoleAllowed =
        devLike && String(env.INFINITECONTEXT_ALLOW_CONSOLE_MAILER ?? '').trim() === 'true';

    return {
        database: Boolean(String(env.DATABASE_URL ?? env.SUPABASE_URL ?? '').trim()),
        account_auth: Boolean(authConfig),
        google_oauth: Boolean(authConfig?.googleClientId && authConfig?.googleClientSecret),
        smtp_mail: mailProvider === 'smtp' && Boolean(String(env.INFINITECONTEXT_SMTP_HOST ?? '').trim()),
        resend_mail:
            mailProvider === 'resend' && Boolean(String(env.INFINITECONTEXT_RESEND_API_KEY ?? '').trim()),
        console_mail: consoleAllowed,
        kv_key_cache: Boolean(options?.kvBound),
    };
}

export type StartupConfigSummary = {
    database_provider: string;
    account_auth: boolean;
    google_oauth: boolean;
    mail_provider: string;
    jwt_configured: boolean;
    public_base_url: string;
};

function isDevEnvironment(env: Record<string, string | undefined>): boolean {
    const nodeEnv = String(env.NODE_ENV ?? '').trim().toLowerCase();
    const icEnv = String(env.INFINITECONTEXT_ENV ?? '').trim().toLowerCase();
    return nodeEnv === 'development' || nodeEnv === 'test' || icEnv === 'development' || icEnv === 'test';
}

export function buildStartupConfigSummary(env: Record<string, string | undefined>): StartupConfigSummary {
    const authConfig = buildAuthRuntimeConfig(env);
    const provider = String(env.DATABASE_PROVIDER ?? '').trim().toLowerCase() || 'unknown';
    let mailProvider = String(env.INFINITECONTEXT_MAIL_PROVIDER ?? 'smtp').trim().toLowerCase();
    if (
        isDevEnvironment(env) &&
        String(env.INFINITECONTEXT_ALLOW_CONSOLE_MAILER ?? '').trim() === 'true'
    ) {
        mailProvider = 'console';
    }
    const publicBaseUrl = String(
        env.INFINITECONTEXT_AUTH_PUBLIC_BASE_URL ?? env.INFINITECONTEXT_PUBLIC_BASE_URL ?? 'http://127.0.0.1:8787',
    )
        .trim()
        .replace(/\/+$/, '');

    return {
        database_provider: provider,
        account_auth: Boolean(authConfig),
        google_oauth: Boolean(authConfig?.googleClientId && authConfig?.googleClientSecret),
        mail_provider: mailProvider,
        jwt_configured: Boolean(authConfig),
        public_base_url: publicBaseUrl,
    };
}

export function logStartupConfigSummary(env: Record<string, string | undefined>): void {
    const summary = buildStartupConfigSummary(env);
    console.log('[infinitecontext-api] startup config:', JSON.stringify(summary));
}

export function warnIfJwtSecretMissing(env: Record<string, string | undefined>): void {
    const secret = String(env.INFINITECONTEXT_JWT_SECRET ?? '').trim();
    if (secret) return;
    console.warn(
        '[infinitecontext-api] WARNING: INFINITECONTEXT_JWT_SECRET is not set — account login (/auth/*) is disabled. ' +
            `Generate one (openssl rand -base64 32) and see ${KEYS_AND_SERVICES_DOC_URL}`,
    );
}

export async function warnIfMailMisconfigured(env: Record<string, string | undefined>, runtime: 'node' | 'worker'): Promise<void> {
    const authConfig = buildAuthRuntimeConfig(env);
    if (!authConfig) return;

    const mailProvider = String(env.INFINITECONTEXT_MAIL_PROVIDER ?? 'smtp').trim().toLowerCase();
    if (mailProvider === 'smtp' && !String(env.INFINITECONTEXT_SMTP_HOST ?? '').trim()) {
        console.warn(
            `[infinitecontext-api] WARNING: INFINITECONTEXT_SMTP_HOST is not set — verification email will fail. See ${KEYS_AND_SERVICES_DOC_URL}`,
        );
        return;
    }
    if (mailProvider === 'resend' && !String(env.INFINITECONTEXT_RESEND_API_KEY ?? '').trim()) {
        console.warn(
            `[infinitecontext-api] WARNING: INFINITECONTEXT_RESEND_API_KEY is not set — verification email will fail. See ${KEYS_AND_SERVICES_DOC_URL}`,
        );
        return;
    }

    try {
        await resolveMailer(env, runtime);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[infinitecontext-api] WARNING: mailer not configured (${message}). See ${KEYS_AND_SERVICES_DOC_URL}`);
    }
}
