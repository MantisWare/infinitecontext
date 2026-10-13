import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveSelectorsToClientNodeIds, resolveUpdateSelectorsToClientNodeIds } from './message-sync-targets';

describe('message-sync-targets', () => {
    it('resolves msg_ id and index selectors to ic_client_node_id', () => {
        const ordered = [
            {
                public_id: 'msg_abc',
                metadata: { ic_client_node_id: 'icn_' + '1'.repeat(24) },
            },
            {
                public_id: 'msg_def',
                metadata: { ic_client_node_id: 'icn_' + '2'.repeat(24) },
            },
        ];
        const byIndex = resolveSelectorsToClientNodeIds(ordered, [1]);
        assert.equal(byIndex.ok, true);
        if (byIndex.ok) assert.equal(byIndex.data[0], 'icn_' + '2'.repeat(24));

        const byPublic = resolveSelectorsToClientNodeIds(ordered, ['msg_abc']);
        assert.equal(byPublic.ok, true);
        if (byPublic.ok) assert.equal(byPublic.data[0], 'icn_' + '1'.repeat(24));

        const updates = resolveUpdateSelectorsToClientNodeIds(ordered, [{ index: 0 }]);
        assert.equal(updates.ok, true);
        if (updates.ok) assert.equal(updates.data[0], 'icn_' + '1'.repeat(24));
    });

    it('rejects selectors when ic_client_node_id is missing', () => {
        const ordered = [{ public_id: 'msg_x', metadata: {} }];
        const result = resolveSelectorsToClientNodeIds(ordered, [0]);
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.code, 'invalid_input');
    });

    it('accepts update metadata ic_client_node_id hint for legacy rows', () => {
        const ordered = [{ public_id: 'msg_x', metadata: {} }];
        const icn = 'icn_' + 'f'.repeat(24);
        const result = resolveUpdateSelectorsToClientNodeIds(ordered, [
            { index: 0, metadata: { ic_client_node_id: icn } },
        ]);
        assert.equal(result.ok, true);
        if (result.ok) assert.deepEqual(result.data, [icn]);
    });
});
