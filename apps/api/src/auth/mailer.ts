import { createConsoleMailer, type Mailer } from '@infinitecontext/auth';

export class MailerConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MailerConfigError';
    }
}

function isDevEnvironment(env: Record<string, string | undefined>): boolean {
    const nodeEnv = String(env.NODE_ENV ?? '').trim().toLowerCase();
    const icEnv = String(env.INFINITECONTEXT_ENV ?? '').trim().toLowerCase();
    return nodeEnv === 'development' || nodeEnv === 'test' || icEnv === 'development' || icEnv === 'test';
}

function createResendMailer(env: Record<string, string | undefined>): Mailer {
    const apiKey = String(env.INFINITECONTEXT_RESEND_API_KEY ?? '').trim();
    const from = String(env.INFINITECONTEXT_MAIL_FROM ?? '').trim();
    if (!apiKey || !from) {
        throw new MailerConfigError('INFINITECONTEXT_RESEND_API_KEY and INFINITECONTEXT_MAIL_FROM are required for Resend mail');
    }

    const send = async (to: string, subject: string, html: string) => {
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ from, to, subject, html }),
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Resend mail failed (${res.status}): ${text}`);
        }
    };

    return {
        async sendVerificationEmail({ to, verifyUrl }) {
            await send(to, 'Verify your InfiniteContext email', `<p><a href="${verifyUrl}">Verify email</a></p>`);
        },
        async sendPasswordResetEmail({ to, resetUrl }) {
            await send(to, 'Reset your InfiniteContext password', `<p><a href="${resetUrl}">Reset password</a></p>`);
        },
    };
}

async function createSmtpMailer(env: Record<string, string | undefined>): Promise<Mailer> {
    const host = String(env.INFINITECONTEXT_SMTP_HOST ?? '').trim();
    const from = String(env.INFINITECONTEXT_MAIL_FROM ?? '').trim();
    if (!host || !from) {
        throw new MailerConfigError('INFINITECONTEXT_SMTP_HOST and INFINITECONTEXT_MAIL_FROM are required for SMTP mail');
    }

    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.createTransport({
        host,
        port: Number.parseInt(String(env.INFINITECONTEXT_SMTP_PORT ?? '587'), 10),
        secure: String(env.INFINITECONTEXT_SMTP_SECURE ?? '').trim() === 'true',
        auth: env.INFINITECONTEXT_SMTP_USER
            ? {
                  user: String(env.INFINITECONTEXT_SMTP_USER),
                  pass: String(env.INFINITECONTEXT_SMTP_PASS ?? ''),
              }
            : undefined,
    });

    const send = async (to: string, subject: string, html: string) => {
        await transporter.sendMail({ from, to, subject, html });
    };

    return {
        async sendVerificationEmail({ to, verifyUrl }) {
            await send(to, 'Verify your InfiniteContext email', `<p><a href="${verifyUrl}">Verify email</a></p>`);
        },
        async sendPasswordResetEmail({ to, resetUrl }) {
            await send(to, 'Reset your InfiniteContext password', `<p><a href="${resetUrl}">Reset password</a></p>`);
        },
    };
}

export async function resolveMailer(env: Record<string, string | undefined>, runtime: 'node' | 'worker'): Promise<Mailer> {
    if (isDevEnvironment(env) && String(env.INFINITECONTEXT_ALLOW_CONSOLE_MAILER ?? '').trim() === 'true') {
        return createConsoleMailer();
    }

    const provider = String(env.INFINITECONTEXT_MAIL_PROVIDER ?? 'smtp').trim().toLowerCase();
    if (provider === 'resend') return createResendMailer(env);
    if (provider === 'smtp') {
        if (runtime === 'worker') {
            throw new MailerConfigError('SMTP mail is not supported on Cloudflare Workers; use INFINITECONTEXT_MAIL_PROVIDER=resend');
        }
        return createSmtpMailer(env);
    }

    throw new MailerConfigError(`Unsupported INFINITECONTEXT_MAIL_PROVIDER: ${provider}`);
}
