import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'drizzle-sync-repository.ts');

describe('DrizzleSyncRepository stale EXISTS', () => {
    it('uses EXISTS + jsonb_array_elements_text instead of loading all changes', () => {
        const src = fs.readFileSync(repoPath, 'utf8');
        assert.match(src, /hasMessageClientMutationSinceOnDb/);
        assert.match(src, /SELECT EXISTS/);
        assert.match(src, /jsonb_array_elements_text/);
        assert.match(src, /affected_client_ids/);
        assert.match(src, /deleted_client_ids/);
    });
});
