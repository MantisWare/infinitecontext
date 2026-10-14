import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { compareHlc, normalizeMutationHlc } from "../../lib/object-store-hlc.mjs";
import { deriveDevH } from "../../lib/storage/layout.mjs";

const TEST_DEK = new Uint8Array(32).fill(3);
import {
  applySortedMutationsToReplica,
  mergeableFromMutation,
  permuteMutationBatches,
  replicaSnapshot,
  shuffleMutations,
  sortMergeableMutations,
} from "../../lib/object-store-merge.mjs";

describe("HLC merge ordering", () => {
  it("compares numeric tuple so index 12 beats index 9 within same wall time", () => {
    const devH = "ABCDEFGHJKMNPQRSTVWXYZ2345";
    const a = normalizeMutationHlc({ wall_ms: 1000, counter: 9, devH }, devH, 9);
    const b = normalizeMutationHlc({ wall_ms: 1000, counter: 12, devH }, devH, 12);
    assert.ok(compareHlc(a, b) < 0);
    const legacyA = `${new Date(1000).toISOString()}#9`;
    const legacyB = `${new Date(1000).toISOString()}#12`;
    assert.ok(String(legacyA).localeCompare(String(legacyB)) > 0);
  });

  it("orders 12 mutations in one segment by HLC counter", () => {
    const devH = "ABCDEFGHJKMNPQRSTVWXYZ2345";
    /** @type {import('../../lib/object-store-merge.mjs').MergeableMutation[]} */
    const items = [];
    for (let index = 0; index < 12; index += 1) {
      items.push(
        mergeableFromMutation(
          {
            client_id: `icn_${String(index).padStart(24, "a")}`,
            op: "context_create",
            payload: { metadata: { index } },
            hlc: { wall_ms: 5000, counter: index, devH },
          },
          devH,
          0,
          index,
          "11111111-1111-4111-8111-111111111111",
          new Date(5000).toISOString(),
        ),
      );
    }
    const sorted = sortMergeableMutations(items);
    for (let i = 1; i < sorted.length; i += 1) {
      assert.ok(compareHlc(sorted[i - 1].hlcTuple, sorted[i].hlcTuple) <= 0);
    }
  });

  it("converges replica across permutations, batch splits, and clock skew", () => {
    const devH = "ABCDEFGHJKMNPQRSTVWXYZ2345";
    /** @type {import('../../lib/object-store-merge.mjs').MergeableMutation[]} */
    const items = [];
    const devices = [
      { devH, uuid: "11111111-1111-4111-8111-111111111111", skew: 0 },
      {
        devH: deriveDevH(TEST_DEK, "22222222-2222-4222-8222-222222222222"),
        uuid: "22222222-2222-4222-8222-222222222222",
        skew: 50_000,
      },
      {
        devH: deriveDevH(TEST_DEK, "33333333-3333-4333-8333-333333333333"),
        uuid: "33333333-3333-4333-8333-333333333333",
        skew: -25_000,
      },
    ];
    let seq = 0;
    for (const dev of devices) {
      for (let index = 0; index < 4; index += 1) {
        items.push(
          mergeableFromMutation(
            {
              client_id: `icn_${dev.uuid.slice(0, 8)}${String(index).padStart(16, "0")}`,
              op: "message_append",
              context_id: "ctx_prop",
              payload: {
                messages: [
                  {
                    id: `msg_${dev.uuid.slice(0, 4)}_${index}`,
                    role: "user",
                    content: { body: `${dev.uuid}-${index}` },
                    metadata: { ic_client_node_id: `msg_${dev.uuid.slice(0, 4)}_${index}` },
                  },
                ],
              },
              hlc: { wall_ms: Date.now() + dev.skew + index, counter: index, devH: dev.devH },
            },
            dev.devH,
            seq,
            index,
            dev.uuid,
            new Date().toISOString(),
          ),
        );
      }
      seq += 1;
    }

    const canonicalMap = new Map();
    applySortedMutationsToReplica(canonicalMap, sortMergeableMutations(items));
    const expected = replicaSnapshot(canonicalMap);

    for (let trial = 0; trial < 5; trial += 1) {
      const shuffledMap = new Map();
      applySortedMutationsToReplica(shuffledMap, shuffleMutations(items));
      assert.deepEqual(replicaSnapshot(shuffledMap), expected);
    }

    const batches = permuteMutationBatches(items, 4);
    const batchedMap = new Map();
    for (const part of batches) {
      applySortedMutationsToReplica(batchedMap, sortMergeableMutations(part));
    }
    assert.deepEqual(replicaSnapshot(batchedMap), expected);
  });
});
