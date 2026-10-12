import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assertJwtSecretLength, AuthConfigError, buildAuthRuntimeConfig } from './config';

describe('auth config', () => {
    it('requires JWT secrets to be at least 32 bytes', () => {
        assert.throws(() => assertJwtSecretLength('too-short'), AuthConfigError);
        assert.doesNotThrow(() => assertJwtSecretLength('01234567890123456789012345678901'));
    });

    it('includes issuer and audience in runtime config', () => {
        const config = buildAuthRuntimeConfig({
            INFINITECONTEXT_JWT_SECRET: '01234567890123456789012345678901',
            INFINITECONTEXT_JWT_ISSUER: 'https://issuer.test',
            INFINITECONTEXT_JWT_AUDIENCE: 'aud-test',
        });
        assert.ok(config);
        assert.equal(config?.jwtIssuer, 'https://issuer.test');
        assert.equal(config?.jwtAudience, 'aud-test');
    });
});
