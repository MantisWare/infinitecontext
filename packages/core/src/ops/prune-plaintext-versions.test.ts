import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStorage } from '../testing/memory-adapter';
import { buildNodeInsertRecords } from '../context-chain';
import { prunePlaintextVersionHeads } from './prune-plaintext-versions';

describe('prunePlaintextVersionHeads', () => {
    it('removes plaintext rows inside mixed historical version heads', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('p1');
        assert.ok(project);

        const rootId = 'ctx_root_prune';
        await storage.insertNodes({
            public_id: rootId,
            project_id: project.id,
            type: 'context',
            content: {},
            metadata: { source: 'test' },
            context_id: null,
        });

        const headV0 = 'ctx_head_v0';
        const headV1 = 'ctx_head_v1';
        await storage.insertNodes([
            {
                public_id: headV0,
                project_id: project.id,
                type: 'context',
                content: {},
                metadata: { operation: 'create' },
                context_id: rootId,
                prev_id: null,
            },
            {
                public_id: headV1,
                project_id: project.id,
                type: 'context',
                content: {},
                metadata: { operation: 'update' },
                context_id: rootId,
                prev_id: headV0,
            },
        ]);

        const plainMsg = buildNodeInsertRecords(
            [{ type: 'message', content: { role: 'user', text: 'plain' }, metadata: {} }],
            project.id,
            headV0,
            null,
        );
        const encMsg = buildNodeInsertRecords(
            [
                {
                    type: 'message',
                    content: {
                        __ic_enc: 1,
                        kid: 'dek_v1',
                        v: 1,
                        alg: 'XC20P',
                        nonce: 'AAAAAAAAAAAAAAAAAAAAAA==',
                        ct: 'AA==',
                    },
                    metadata: { ic_client_node_id: 'icn_' + 'a'.repeat(24) },
                },
            ],
            project.id,
            headV0,
            plainMsg[0]!.public_id,
        );
        await storage.insertNodes([...plainMsg, ...encMsg]);

        const currentPlain = buildNodeInsertRecords(
            [{ type: 'message', content: { role: 'user', text: 'current' }, metadata: {} }],
            project.id,
            headV1,
            null,
        );
        const currentEnc = buildNodeInsertRecords(
            [
                {
                    type: 'message',
                    content: {
                        __ic_enc: 1,
                        kid: 'dek_v1',
                        v: 1,
                        alg: 'XC20P',
                        nonce: 'BBBBBBBBBBBBBBBBBBBBBB==',
                        ct: 'BB==',
                    },
                    metadata: { ic_client_node_id: 'icn_' + 'b'.repeat(24) },
                },
            ],
            project.id,
            headV1,
            currentPlain[0]!.public_id,
        );
        await storage.insertNodes([...currentPlain, ...currentEnc]);

        const result = await prunePlaintextVersionHeads(storage, project.id, rootId);
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.ok(result.data.plainNodesRemoved >= 1);

        const v0Nodes = await storage.findNonContextNodes(headV0);
        assert.ok(v0Nodes.every((n) => n.content.__ic_enc === 1));
    });
});
