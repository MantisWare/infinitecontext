import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    deterministicClientNodeIdFromPublicId,
    ensurePlaintextAppendClientNodeId,
    generateClientNodeId,
} from './ic-client-node-id';

describe('ic-client-node-id', () => {
    it('deterministicClientNodeIdFromPublicId is stable', () => {
        const a = deterministicClientNodeIdFromPublicId('msg_abc123');
        const b = deterministicClientNodeIdFromPublicId('msg_abc123');
        assert.equal(a, b);
        assert.match(a, /^icn_[0-9a-f]{24}$/);
    });

    it('stamps plaintext append metadata when missing', () => {
        const meta = ensurePlaintextAppendClientNodeId({ role: 'user', text: 'hi' }, {});
        assert.match(String(meta.ic_client_node_id), /^icn_[0-9a-f]{24}$/);
    });

    it('does not stamp encrypted vault content without client icn', () => {
        const meta = ensurePlaintextAppendClientNodeId(
            { __ic_enc: 1, kid: 'k', v: 1, alg: 'x', nonce: 'n', ct: 'c' },
            { source: 'vault' },
        );
        assert.equal(meta.ic_client_node_id, undefined);
    });

    it('generateClientNodeId produces valid ids', () => {
        assert.match(generateClientNodeId(), /^icn_[0-9a-f]{24}$/);
    });
});
