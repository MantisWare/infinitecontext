import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { hashAuthPassword, verifyAuthPassword } from './password';

describe('auth password hashing', () => {
    it('hashes and verifies login passwords with Argon2id', async () => {
        const hash = await hashAuthPassword('correct horse battery');
        assert.ok(hash.length > 20);
        assert.equal(await verifyAuthPassword('correct horse battery', hash), true);
        assert.equal(await verifyAuthPassword('wrong', hash), false);
    });
});
