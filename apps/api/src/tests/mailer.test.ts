import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MailerConfigError, resolveMailer } from '../auth/mailer';

describe('resolveMailer', () => {
    it('allows console mailer in development', async () => {
        const mailer = await resolveMailer({ NODE_ENV: 'development' }, 'node');
        assert.ok(mailer);
    });

    it('requires a real provider outside development', async () => {
        await assert.rejects(
            () => resolveMailer({ NODE_ENV: 'production', INFINITECONTEXT_MAIL_PROVIDER: 'resend' }, 'worker'),
            MailerConfigError,
        );
    });
});
