import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStorage } from '../testing/memory-adapter';
import { generatePublicId } from '../public-ids';
import { buildNodeInsertRecords } from '../context-chain';
import { appendMessages } from './append-messages';
import { deleteMessages } from './delete-messages';
import { updateMessages } from './update-messages';
import { deterministicClientNodeIdFromPublicId } from '../ic-client-node-id';

async function seedLegacyPlainContext(storage: MemoryStorage, projectId: number) {
    const rootId = generatePublicId('context');
    await storage.insertNodes({
        public_id: rootId,
        project_id: projectId,
        type: 'context',
        context_id: null,
        parent_id: null,
        content: {},
        metadata: {},
    });
    const headId = generatePublicId('context');
    await storage.insertNodes({
        public_id: headId,
        project_id: projectId,
        type: 'context',
        context_id: rootId,
        prev_id: null,
        content: {},
        metadata: { operation: 'create' },
    });
    const msgId = generatePublicId('msg');
    const records = buildNodeInsertRecords(
        [{ type: 'message', content: { text: 'legacy' }, metadata: {} }],
        projectId,
        headId,
        null,
    );
    records[0]!.public_id = msgId;
    await storage.insertNodes(records);
    return { rootId, msgId };
}

describe('legacy messages without ic_client_node_id', () => {
    it('PATCH and DELETE resolve via deterministic fallback', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('p');
        const { rootId, msgId } = await seedLegacyPlainContext(storage, project!.id);
        const expected = deterministicClientNodeIdFromPublicId(msgId);

        const patch = await updateMessages(storage, project!.id, rootId, {
            updates: [{ index: 0, text: 'patched' }],
        });
        assert.equal(patch.ok, true);
        if (patch.ok) assert.deepEqual(patch.data.affected_client_ids, [expected]);

        const del = await deleteMessages(storage, project!.id, rootId, { ids: [0] });
        assert.equal(del.ok, true);
        if (del.ok) assert.deepEqual(del.data.deleted_client_ids, [expected]);
    });

    it('append stamps ic_client_node_id on plaintext daemon-style payloads', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('p');
        const { rootId } = await seedLegacyPlainContext(storage, project!.id);
        const appended = await appendMessages(storage, project!.id, rootId, {
            role: 'user',
            content: { message: 'daemon line' },
        });
        assert.equal(appended.ok, true);
        if (appended.ok) {
            assert.match(String(appended.data.data[0]?.metadata?.ic_client_node_id ?? ''), /^icn_[0-9a-f]{24}$/);
        }
    });
});
