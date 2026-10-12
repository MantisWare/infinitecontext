import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isAllowedOAuthRedirectUri } from './oauth-redirect';

describe('oauth redirect allowlist', () => {
    it('allows localhost callback ports', () => {
        assert.equal(isAllowedOAuthRedirectUri('http://127.0.0.1:53682/callback'), true);
    });

    it('rejects non-local redirect URIs', () => {
        assert.equal(isAllowedOAuthRedirectUri('https://evil.example/callback'), false);
        assert.equal(isAllowedOAuthRedirectUri('http://127.0.0.1:53682/callback?x=1'), false);
    });
});
