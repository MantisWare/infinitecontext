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
