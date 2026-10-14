import {
  decryptLogSegment,
  deriveDevH,
  encryptLogSegment,
  layoutRootPath,
  layoutSegmentEnvelopeDigest,
  logSegmentRelativePath,
  verifyLogSegmentChain,
} from "./storage/layout.mjs";
import {
  advanceVectorCursorDevH,
  normalizeVectorSyncCursor,
} from "./sync-cursor.mjs";

const META_REL = "sync/meta.json";

/** @param {string} layoutPrefix */
function metaKey(layoutPrefix) {
  return `${layoutRootPath(layoutPrefix)}/${META_REL}`;
}

/**
 * @param {import("./storage/types.mjs").StorageAdapter} adapter
 * @param {string} key
 */
async function readJsonObject(adapter, key) {
  const row = await adapter.get(key);
  if (!row?.body) {
    return null;
  }
  return JSON.parse(new TextDecoder().decode(row.body));
}

/**
 * @param {import("./storage/types.mjs").StorageAdapter} adapter
 * @param {string} key
 * @param {unknown} value
 */
async function writeJsonObject(adapter, key, value) {
  const body = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  const head = await adapter.head(key);
  if (head) {
    await adapter.put(key, body, { ifMatch: head.etag });
  } else {
    await adapter.put(key, body, { ifNoneMatch: "*" });
  }
}

/**
 * @param {import("./storage/types.mjs").StorageAdapter} adapter
 * @param {string} layoutPrefix
 */
async function loadMeta(adapter, layoutPrefix) {
  const existing = await readJsonObject(adapter, metaKey(layoutPrefix));
  if (existing && typeof existing === "object") {
    return {
      head_sequence: Number(existing.head_sequence ?? 0),
      trusted_heads: existing.trusted_heads ?? {},
      history: Array.isArray(existing.history) ? existing.history : [],
      client_ids: existing.client_ids ?? {},
      conflicts: Array.isArray(existing.conflicts) ? existing.conflicts : [],
    };
  }
  return {
    head_sequence: 0,
    trusted_heads: {},
    history: [],
    client_ids: {},
    conflicts: [],
  };
}

/**
 * @param {ReturnType<typeof loadMeta> extends Promise<infer T> ? T : never} meta
 * @param {import("./storage/types.mjs").StorageAdapter} adapter
 * @param {string} layoutPrefix
 */
async function saveMeta(adapter, layoutPrefix, meta) {
  await writeJsonObject(adapter, metaKey(layoutPrefix), meta);
}

/** @param {unknown} raw */
function parseStrictBaseSequence(raw) {
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  }
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    const n = Number(raw.trim());
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  return null;
}

/**
 * @param {unknown[]} history
 * @param {number} baseSeq
 * @param {string[]} targetClientIds
 */
function hasMessageMutationSince(history, baseSeq, targetClientIds) {
  const targets = new Set(targetClientIds);
  for (const row of history) {
    if (Number(row.sequence) <= baseSeq) continue;
    const op = String(row.op ?? "");
    if (op !== "message_update" && op !== "message_delete") continue;
    const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
    for (const key of ["affected_client_ids", "deleted_client_ids"]) {
      const list = payload[key];
      if (!Array.isArray(list)) continue;
      for (const id of list) {
        if (typeof id === "string" && targets.has(id)) return true;
      }
    }
  }
  return false;
}

/**
 * @param {string} key
 */
function parseLogSegmentKey(key) {
  const match = /\/log\/([0-9A-HJKMNP-TV-Z]{26})\/(\d{12})\.enc$/.exec(key);
  if (!match) return null;
  return { devH: match[1], seq: Number(match[2]) };
}

/**
 * @param {import("./storage/types.mjs").StorageAdapter} adapter
 * @param {string} layoutPrefix
 */
async function listAllLogSegmentKeys(adapter, layoutPrefix) {
  const prefix = `${layoutRootPath(layoutPrefix)}/log/`;
  const page = await adapter.list(prefix, { limit: 10_000 });
  return page.objects.map((row) => row.key).filter((key) => parseLogSegmentKey(key));
}

/**
 * @param {import("./storage/types.mjs").StorageAdapter} adapter
 * @param {string} key
 */
async function readSegmentEnvelope(adapter, key) {
  const row = await adapter.get(key);
  if (!row?.body) return null;
  return JSON.parse(new TextDecoder().decode(row.body));
}

/**
 * @param {object} ctx
 * @param {import("./storage/types.mjs").StorageAdapter} ctx.adapter
 * @param {Uint8Array} ctx.dek
 * @param {string} ctx.layoutPrefix
 * @param {string} ctx.selfDevH
 * @param {string} ctx.deviceUuid
 * @param {() => void | Promise<void>} [ctx.testHookAfterSegmentWrite]
 */
export async function objectStoreFetchSyncStatus(ctx) {
  const meta = await loadMeta(ctx.adapter, ctx.layoutPrefix);
  return { head_sequence: meta.head_sequence };
}

/**
 * @param {object} ctx
 * @param {{ since?: unknown, limit?: number }} options
 */
export async function objectStorePullSyncChanges(ctx, options = {}) {
  const limit = options.limit ?? 500;
  const cursor = normalizeVectorSyncCursor(options.since);
  const meta = await loadMeta(ctx.adapter, ctx.layoutPrefix);
  /** @type {{ devH: string, seq: number, key: string, record: import("./storage/layout.mjs").LayoutLogSegmentRecord }[]} */
  const pendingSegments = [];
  for (const key of await listAllLogSegmentKeys(ctx.adapter, ctx.layoutPrefix)) {
    const parsed = parseLogSegmentKey(key);
    if (!parsed) continue;
    const after = cursor.v[parsed.devH] ?? -1;
    if (parsed.seq <= after) continue;
    const envelope = await readSegmentEnvelope(ctx.adapter, key);
    if (!envelope) continue;
    const trusted = meta.trusted_heads[parsed.devH] ?? { seq: -1, digest: "" };
    const segments = [];
    for (let seq = 0; seq <= parsed.seq; seq += 1) {
      const segKey = logSegmentRelativePath(ctx.layoutPrefix, parsed.devH, seq);
      const env = await readSegmentEnvelope(ctx.adapter, segKey);
      if (!env) {
        throw new Error(`Missing segment ${segKey} while verifying chain`);
      }
      segments.push({ seq, envelope: env });
    }
    const head = segments[segments.length - 1];
    const headAnchor = {
      seq: head.seq,
      digest: layoutSegmentEnvelopeDigest(head.envelope),
    };
    verifyLogSegmentChain(ctx.dek, parsed.devH, segments, headAnchor);
    if (trusted.seq >= 0 && trusted.seq <= head.seq) {
      const trustedEnv = segments[trusted.seq]?.envelope;
      if (trustedEnv && layoutSegmentEnvelopeDigest(trustedEnv) !== trusted.digest) {
        throw new Error("Trusted local log head digest mismatch");
      }
    }
    const record = decryptLogSegment(ctx.dek, parsed.devH, parsed.seq, envelope);
    pendingSegments.push({ ...parsed, key, record });
  }

  pendingSegments.sort((a, b) => {
    const hlc = String(a.record.created_at).localeCompare(String(b.record.created_at));
    if (hlc !== 0) return hlc;
    const dev = a.devH.localeCompare(b.devH);
    if (dev !== 0) return dev;
    return a.seq - b.seq;
  });

  /** @type {any[]} */
  const collectedChanges = [];

  for (const row of pendingSegments) {
    if (collectedChanges.length >= limit) break;
    const envelope = await readSegmentEnvelope(ctx.adapter, row.key);
    if (!envelope) continue;
    meta.trusted_heads[row.devH] = {
      seq: row.seq,
      digest: layoutSegmentEnvelopeDigest(envelope),
    };
    for (const mutation of row.record.mutations) {
      if (!mutation || typeof mutation !== "object") continue;
      meta.head_sequence += 1;
      const change = {
        sequence: meta.head_sequence,
        op: mutation.op,
        context_id: mutation.context_id ?? null,
        client_id: mutation.client_id,
        payload: mutation.payload ?? {},
        device_id: row.record.dev,
        created_at: row.record.created_at,
      };
      meta.history.push({
        ...change,
        device_devH: row.devH,
        log_seq: row.seq,
      });
      if (mutation.client_id) {
        meta.client_ids[mutation.client_id] = true;
      }
      collectedChanges.push(change);
      if (collectedChanges.length >= limit) break;
    }
    advanceVectorCursorDevH(cursor, row.devH, row.seq);
  }

  await saveMeta(ctx.adapter, ctx.layoutPrefix, meta);
  return {
    changes: collectedChanges,
    head_sequence: meta.head_sequence,
    next_since: cursor,
    has_more: pendingSegments.length > 0 && collectedChanges.length >= limit,
    conflicts: meta.conflicts,
  };
}

/**
 * @param {object} ctx
 * @param {unknown[]} mutations
 */
export async function objectStorePushSyncMutations(ctx, mutations) {
  const batch = Array.isArray(mutations) ? mutations : [];
  const meta = await loadMeta(ctx.adapter, ctx.layoutPrefix);
  /** @type {string[]} */
  const applied = [];
  /** @type {string[]} */
  const duplicate = [];
  /** @type {object[]} */
  const failed = [];
  /** @type {object[]} */
  const conflicts = [];
  /** @type {object[]} */
  const effects = [];

  for (const raw of batch) {
    const mutation = raw && typeof raw === "object" ? raw : null;
    const clientId = mutation?.client_id ? String(mutation.client_id) : "";
    if (!clientId) continue;
    if (meta.client_ids[clientId]) {
      duplicate.push(clientId);
      continue;
    }

    if (mutation.op === "message_delete") {
      const baseSeq = parseStrictBaseSequence(
        mutation.base_sequence ?? mutation.payload?.base_sequence,
      );
      if (baseSeq === null) {
        failed.push({
          client_id: clientId,
          code: "invalid_input",
          message:
            mutation.base_sequence === undefined && mutation.payload?.base_sequence === undefined
              ? "base_sequence is required for message_delete"
              : "Invalid base_sequence",
          retryable: false,
        });
        continue;
      }
      if (baseSeq > meta.head_sequence) {
        failed.push({
          client_id: clientId,
          code: "invalid_input",
          message: "Invalid base_sequence",
          retryable: false,
        });
        continue;
      }
      const ids = mutation.payload?.ids;
      const idList = Array.isArray(ids) ? ids.map(String) : [];
      if (hasMessageMutationSince(meta.history, baseSeq, idList)) {
        conflicts.push({
          id: `conf_${clientId}`,
          context_id: String(mutation.context_id ?? ""),
          kind: "delete_stale_base",
          client_id: clientId,
          sequence: meta.head_sequence + 1,
          left_payload: { base_sequence: baseSeq, server_sequence: baseSeq, op: "message_delete" },
          right_payload: { delete_targets: idList },
          created_at: new Date().toISOString(),
          resolved_at: null,
        });
        continue;
      }
    }
  }

  const accepted = batch.filter((raw) => {
    const clientId = raw?.client_id ? String(raw.client_id) : "";
    if (!clientId) return false;
    if (meta.client_ids[clientId]) return false;
    return !failed.some((f) => f.client_id === clientId) && !conflicts.some((c) => c.client_id === clientId);
  });

  if (accepted.length > 0) {
    const selfHead = meta.trusted_heads[ctx.selfDevH] ?? { seq: -1, digest: "" };
    const nextSeq = selfHead.seq + 1;
    const prevDigest = nextSeq === 0 ? "" : String(selfHead.digest ?? "");
    const record = {
      dev: ctx.deviceUuid,
      seq: nextSeq,
      prev_digest: prevDigest,
      created_at: new Date().toISOString(),
      mutations: accepted,
    };
    const envelope = encryptLogSegment(ctx.dek, ctx.selfDevH, record);
    const key = logSegmentRelativePath(ctx.layoutPrefix, ctx.selfDevH, nextSeq);
    await ctx.adapter.put(key, new TextEncoder().encode(JSON.stringify(envelope)), {
      ifNoneMatch: "*",
    });
    if (ctx.testHookAfterSegmentWrite) {
      await ctx.testHookAfterSegmentWrite();
    }
    meta.trusted_heads[ctx.selfDevH] = {
      seq: nextSeq,
      digest: layoutSegmentEnvelopeDigest(envelope),
    };
    for (const raw of accepted) {
      const clientId = String(raw.client_id);
      meta.client_ids[clientId] = true;
      applied.push(clientId);
      effects.push({
        client_id: clientId,
        context_id: raw.context_id ?? raw.payload?.context_id,
      });
      meta.head_sequence += 1;
      let payload = raw.payload && typeof raw.payload === "object" ? { ...raw.payload } : {};
      if (raw.op === "message_update") {
        const rows = Array.isArray(payload.messages) ? payload.messages : payload.data;
        if (Array.isArray(rows)) {
          payload.affected_client_ids = rows
            .map((row) => row?.metadata?.ic_client_node_id ?? row?.id)
            .filter(Boolean);
        }
      }
      if (raw.op === "message_delete") {
        const ids = payload.ids;
        payload.deleted_client_ids = Array.isArray(ids) ? ids.map(String) : [];
      }
      meta.history.push({
        sequence: meta.head_sequence,
        op: raw.op,
        context_id: raw.context_id ?? null,
        client_id: clientId,
        payload,
        device_devH: ctx.selfDevH,
        log_seq: nextSeq,
      });
    }
  }

  meta.conflicts = [...meta.conflicts, ...conflicts];
  await saveMeta(ctx.adapter, ctx.layoutPrefix, meta);

  return {
    head_sequence: meta.head_sequence,
    applied,
    duplicate,
    conflicts,
    effects,
    failed: failed.length ? failed : undefined,
  };
}

/**
 * @param {object} ctx
 */
export async function objectStoreFetchSyncConflicts(ctx) {
  const meta = await loadMeta(ctx.adapter, ctx.layoutPrefix);
  return { data: meta.conflicts };
}

export { deriveDevH };
