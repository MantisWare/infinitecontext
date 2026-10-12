import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ClientAuthError } from './load-client-auth';

describe('MCP client auth errors', () => {
    it('uses a clean session message without stack-specific wording', () => {
        const error = new ClientAuthError(
            'Session expired or invalid. Run `infinitecontext login` to refresh your account session.',
        );
        assert.equal(error.name, 'ClientAuthError');
        assert.match(error.message, /infinitecontext login/);
    });
});
