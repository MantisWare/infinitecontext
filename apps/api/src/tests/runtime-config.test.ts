import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MissingConfigError, buildStartupConfigSummary, requireEnv } from '../runtime-config';

describe('runtime-config', () => {
    it('requireEnv throws MissingConfigError with doc link', () => {
        assert.throws(() => requireEnv({}, 'DATABASE_URL'), (error: unknown) => {
            assert.ok(error instanceof MissingConfigError);
            assert.match(String(error.message), /DATABASE_URL/);
            assert.match(String(error.message), /keys-and-services/);
            return true;
        });
    });

    it('warnIfMailMisconfigured warns when SMTP host missing on Node', async () => {
        const { warnIfMailMisconfigured } = await import('../runtime-config');
        const warnings: string[] = [];
        const original = console.warn;
        console.warn = (msg: string) => {
            warnings.push(String(msg));
        };
        try {
            await warnIfMailMisconfigured(
                {
                    INFINITECONTEXT_JWT_SECRET: 'test-jwt-secret-must-be-at-least-32-bytes-long',
                    INFINITECONTEXT_MAIL_PROVIDER: 'smtp',
                },
                'node',
            );
        } finally {
            console.warn = original;
        }
        assert.ok(warnings.some((w) => w.includes('INFINITECONTEXT_SMTP_HOST')));
    });

    it('buildStartupConfigSummary omits secrets', () => {
        const summary = buildStartupConfigSummary({
            DATABASE_PROVIDER: 'postgres',
            INFINITECONTEXT_JWT_SECRET: 'test-jwt-secret-must-be-at-least-32-bytes-long',
            INFINITECONTEXT_MAIL_PROVIDER: 'smtp',
        });
        assert.equal(summary.database_provider, 'postgres');
        assert.equal(summary.jwt_configured, true);
        assert.equal(summary.mail_provider, 'smtp');
        assert.ok(!('jwtSecret' in summary));
    });
});
