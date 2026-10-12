import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MailerConfigError, resolveMailer } from '../auth/mailer';

describe('resolveMailer', () => {
    it('allows console mailer in development when explicitly enabled', async () => {
        const mailer = await resolveMailer(
            { NODE_ENV: 'development', INFINITECONTEXT_ALLOW_CONSOLE_MAILER: 'true' },
            'node',
        );
        assert.ok(mailer);
    });

    it('ignores console mailer flag in production', async () => {
        await assert.rejects(
            () =>
                resolveMailer(
                    {
                        NODE_ENV: 'production',
                        INFINITECONTEXT_ALLOW_CONSOLE_MAILER: 'true',
                        INFINITECONTEXT_MAIL_PROVIDER: 'resend',
                    },
                    'node',
                ),
            MailerConfigError,
        );
    });

    it('requires a real provider outside development', async () => {
        await assert.rejects(
            () => resolveMailer({ NODE_ENV: 'production', INFINITECONTEXT_MAIL_PROVIDER: 'resend' }, 'worker'),
            MailerConfigError,
        );
    });
});
