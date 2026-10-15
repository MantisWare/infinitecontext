import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applySyncChangeToReplica, createEmptySyncReplica } from "../../lib/sync-replica-apply.mjs";
import { mergeableFromMutation, sortMergeableMutations } from "../../lib/object-store-merge.mjs";
import { deriveDevH } from "../../lib/storage/layout.mjs";
import {
  assertConvergesAcrossRandomPulls,
  syncChangeFromMergeable,
} from "../helpers/object-store-replica-convergence.mjs";
import {
  ALL_CONVERGENCE_SCENARIOS,
  msg,
  scenarioThreeUpdates,
  TEST_DEK,
} from "./object-store-replica-scenarios.mjs";

describe("object store replica conflicts", () => {
  for (const [label, scenarioFn] of ALL_CONVERGENCE_SCENARIOS) {
    it(`${label} — full rows match across 300 random pull orders`, () => {
      assertConvergesAcrossRandomPulls(scenarioFn(), (replica, change) => {
        applySyncChangeToReplica(replica, change, () => {});
      });
    });
  }

  it("sequential updates on one device do not emit lww_superseded conflicts", () => {
    const items = scenarioThreeUpdates();
    const sorted = sortMergeableMutations(items);
    const replica = createEmptySyncReplica();
    for (const item of sorted) {
      applySyncChangeToReplica(replica, syncChangeFromMergeable(item), () => {});
    }
    assert.equal(replica.sync_conflicts.length, 0);
    assert.equal(replica.messages.icn_three_msg.payload.content.body, "u3");
  });

  it("covered delete does not add a tombstone conflict for a seen value", () => {
    const devA = deriveDevH(TEST_DEK, "11111111-1111-4111-8111-111111111111");
    const ctx = "ctx_cov";
    const msgId = "icn_cov";
    const deleteBase = { kind: "vector", v: { [devA]: 2 } };
    const replica = createEmptySyncReplica();
    applySyncChangeToReplica(
      replica,
      syncChangeFromMergeable(
        mergeableFromMutation(
          { client_id: "x0", op: "message_append", context_id: ctx, payload: { messages: [msg(msgId, "win")] }, hlc: { wall_ms: 3000, counter: 0, devH: devA } },
          devA, 2, 0, "11111111-1111-4111-8111-111111111111", "2026-01-01T00:00:00.000Z",
        ),
      ),
      () => {},
    );
    applySyncChangeToReplica(
      replica,
      syncChangeFromMergeable(
        mergeableFromMutation(
          {
            client_id: "x1",
            op: "message_delete",
            context_id: ctx,
            base_vector: deleteBase,
            payload: { ids: [msgId], base_vector: deleteBase },
            hlc: { wall_ms: 4000, counter: 0, devH: devA },
          },
          devA, 3, 0, "11111111-1111-4111-8111-111111111111", "2026-01-01T00:00:00.000Z",
        ),
      ),
      () => {},
    );
    assert.equal(replica.sync_conflicts.length, 0);
  });

  it("does not record a conflict for delete with no prior message payload", () => {
    const devA = deriveDevH(TEST_DEK, "11111111-1111-4111-8111-111111111111");
    const replica = createEmptySyncReplica();
    applySyncChangeToReplica(
      replica,
      syncChangeFromMergeable(
        mergeableFromMutation(
          {
            client_id: "icn_del_only",
            op: "message_delete",
            context_id: "ctx_x",
            base_vector: { kind: "vector", v: {} },
            payload: { ids: ["icn_missing_msg"], base_vector: { kind: "vector", v: {} } },
            hlc: { wall_ms: 4000, counter: 0, devH: devA },
          },
          devA, 0, 0, "11111111-1111-4111-8111-111111111111", new Date().toISOString(),
        ),
      ),
      () => {},
    );
    assert.equal(replica.sync_conflicts.length, 0);
  });
});
