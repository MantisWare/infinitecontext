import {
  DecryptionFailedError,
  decryptNodeContent,
  decryptNodeMetadata,
  encryptNodeContent,
  encryptNodeMetadata,
  generateClientNodeId,
  isClientNodeId,
  isEncryptedContent,
  pickCleartextMetadata,
} from "./ic-crypto.mjs";

import { randomRootAadNonce } from "./vault-agent.mjs";
import { sleep, withRateLimitRetry } from "./vault-http-retry.mjs";

const APPEND_CONFLICT_MAX_ATTEMPTS = 6;

function parseHttpErrorCode(error) {
  if (!error?.bodyText) return null;
  try {
    return JSON.parse(String(error.bodyText))?.code ?? null;
  } catch {
    return null;
  }
}

function appendInputWithoutClientIds(input) {
  const list = Array.isArray(input) ? input : [input];
  return list.length === 1
    ? (() => {
        const { id: _id, ...rest } = list[0];
        return rest;
      })()
    : list.map(({ id: _id, ...rest }) => rest);
}

function stableNodeId(row) {
  const fromMeta = row?.metadata?.ic_client_node_id;
  if (typeof fromMeta === "string" && fromMeta.length > 0) return fromMeta;
  return String(row.id);
}

function messageAadBase(ctx, contextId, nodePublicId) {
  return {
    contextId,
    userPublicId: ctx.userPublicId,
    dekVersion: ctx.dekVersion,
    nodePublicId,
  };
}

function withClientNodeId(metadata, nodeId) {
  return { ...(metadata ?? {}), ic_client_node_id: nodeId };
}

function pickContentEnvelope(row) {
  return {
    __ic_enc: row.__ic_enc,
    kid: row.kid,
    v: row.v,
    alg: row.alg,
    nonce: row.nonce,
    ct: row.ct,
  };
}

function stripMessageShell(row) {
  const { id: _id, index: _index, metadata: _meta, created_at: _ca, ...content } = row;
  return content;
}

function resolveAadNodeId(msg) {
  const meta = msg?.metadata;
  if (meta && typeof meta === "object" && isClientNodeId(meta.ic_client_node_id)) {
    return meta.ic_client_node_id;
  }
  if (typeof msg?.id === "string" && isClientNodeId(msg.id)) return msg.id;
  return typeof msg?.id === "string" ? msg.id : null;
}

function encryptMessageFields(message, ctx, contextId, nodePublicId) {
  const { metadata, id: _id, index: _index, ...content } = message;
  const meta = withClientNodeId(metadata && typeof metadata === "object" ? metadata : {}, nodePublicId);
  const binding = messageAadBase(ctx, contextId, nodePublicId);
  return {
    content: encryptNodeContent(ctx.dek, ctx.dekVersion, content, binding),
    metadata: encryptNodeMetadata(ctx.dek, ctx.dekVersion, meta, binding),
  };
}

function decryptMessageRow(row, ctx, contextId, { allowPlaintext = false } = {}) {
  const binding = messageAadBase(ctx, contextId, stableNodeId(row));
  try {
    let body;
    if (isEncryptedContent(row)) {
      body = decryptNodeContent(ctx.dek, pickContentEnvelope(row), binding, { allowPlaintext });
    } else if (allowPlaintext) {
      body = stripMessageShell(row);
    } else {
      throw new DecryptionFailedError("Expected encrypted message content");
    }
    const metadata =
      row?.metadata && typeof row.metadata === "object"
        ? decryptNodeMetadata(ctx.dek, row.metadata, binding, { allowPlaintext })
        : (row?.metadata ?? {});
    return { ...body, id: row.id, index: row.index, metadata };
  } catch (error) {
    return {
      id: row.id,
      index: row.index,
      decrypt_error: error instanceof DecryptionFailedError ? error.message : "Failed to decrypt message",
      metadata: {},
    };
  }
}

function prepareRootMetadata(metadata, ctx) {
  const input = metadata && typeof metadata === "object" ? { ...metadata } : {};
  if (!input.ic_root_aad) input.ic_root_aad = randomRootAadNonce();
  const cleartextOnly = pickCleartextMetadata(input);
  const sensitive = { ...input };
  for (const key of Object.keys(cleartextOnly)) delete sensitive[key];
  if (Object.keys(sensitive).length === 0) return input;
  return encryptNodeMetadata(
    ctx.dek,
    ctx.dekVersion,
    input,
    { contextId: input.ic_root_aad, userPublicId: ctx.userPublicId },
    { rootMetadata: true },
  );
}

function decryptRootMetadata(metadata, ctx) {
  try {
    return decryptNodeMetadata(
      ctx.dek,
      metadata ?? {},
      { contextId: String(metadata?.ic_root_aad ?? ""), userPublicId: ctx.userPublicId },
      { rootMetadata: true },
    );
  } catch (error) {
    return {
      ...(metadata ?? {}),
      decrypt_error: error instanceof DecryptionFailedError ? error.message : "Failed to decrypt context metadata",
    };
  }
}

async function loadSourceRootMetadata(client, sourceContextId) {
  const res = await client.get(sourceContextId);
  return res?.metadata ?? {};
}

async function rebindForkedContext(client, ctx, newContextId, sourceContextId) {
  const res = await client.get(newContextId);
  const updates = [];
  for (const row of res.data ?? []) {
    if (!isEncryptedContent(row)) continue;
    let plaintext;
    try {
      plaintext = decryptNodeContent(ctx.dek, pickContentEnvelope(row), {
        contextId: sourceContextId,
        userPublicId: ctx.userPublicId,
        dekVersion: ctx.dekVersion,
        nodePublicId: stableNodeId(row),
        nodeIndex: row.index,
      });
    } catch {
      continue;
    }
    const meta =
      row.metadata && typeof row.metadata === "object"
        ? decryptNodeMetadata(ctx.dek, row.metadata, {
            contextId: sourceContextId,
            userPublicId: ctx.userPublicId,
            dekVersion: ctx.dekVersion,
            nodePublicId: stableNodeId(row),
            nodeIndex: row.index,
          })
        : {};
    const nodeId = stableNodeId(row);
    const { content, metadata } = encryptMessageFields(
      { ...plaintext, metadata: meta },
      ctx,
      newContextId,
      nodeId,
    );
    updates.push({ id: row.id, ...content, metadata });
  }
  if (updates.length > 0) {
    await client.update(newContextId, { updates });
  }
}

async function encryptAppendBatch(client, contextId, items, ctx) {
  const list = Array.isArray(items) ? items : [items];
  const encrypted = [];
  for (const msg of list) {
    const nodeId =
      typeof msg.id === "string" && msg.id.startsWith("icn_") ? msg.id : generateClientNodeId();
    const { content, metadata } = encryptMessageFields(
      { ...msg, metadata: withClientNodeId(msg.metadata, nodeId) },
      ctx,
      contextId,
      nodeId,
    );
    encrypted.push({ id: nodeId, ...content, metadata });
  }
  return encrypted;
}

function appendResponseFromExistingHead(snap, encryptedPayload) {
  const rows = snap?.data ?? [];
  const ids = encryptedPayload.map((row) => row.id).filter((id) => typeof id === "string");
  if (ids.length !== encryptedPayload.length) return null;
  const matched = ids.map((id) => rows.find((row) => stableNodeId(row) === id));
  if (matched.some((row) => !row)) return null;
  return { data: matched, version: snap.version ?? 0 };
}

export function wrapInfiniteContextWithVault(client, vaultCtx, { migrationMode = false } = {}) {
  if (!vaultCtx?.dek) return client;

  const ctx = {
    dek: vaultCtx.dek,
    dekVersion: vaultCtx.dekVersion ?? 1,
    userPublicId: vaultCtx.userPublicId,
    contextId: null,
  };
  const allowPlaintext = migrationMode;

  function mapGetResponse(res, contextId) {
    res.data = (res.data ?? []).map((row) => decryptMessageRow(row, ctx, contextId, { allowPlaintext }));
    return res;
  }

  return {
    ...client,
    async create(input = {}) {
      const sourceId = input.from;
      let metadataInput = input.metadata ?? {};
      if (sourceId) {
        const sourceMeta = await loadSourceRootMetadata(client, sourceId);
        const decryptedSource = decryptRootMetadata(sourceMeta, ctx);
        metadataInput = { ...decryptedSource, ...metadataInput };
        delete metadataInput.ic_root_aad;
      }
      const metadata = prepareRootMetadata(metadataInput, ctx);
      const res = await client.create({ ...input, metadata });
      ctx.contextId = res.id;
      if (res.metadata) {
        res.metadata = decryptRootMetadata(res.metadata, ctx);
      }
      if (sourceId) {
        await rebindForkedContext(client, ctx, res.id, sourceId);
      }
      return res;
    },

    async append(contextId, input) {
      ctx.contextId = contextId;
      return withRateLimitRetry(async () => {
        let batchInput = input;
        for (let attempt = 0; attempt < APPEND_CONFLICT_MAX_ATTEMPTS; attempt += 1) {
          let encrypted;
          try {
            encrypted = await encryptAppendBatch(client, contextId, batchInput, ctx);
            const res = await client.append(contextId, encrypted.length === 1 ? encrypted[0] : encrypted);
            return mapGetResponse(res, contextId);
          } catch (error) {
            const status = error?.status;
            const code = parseHttpErrorCode(error);
            if (status === 409 && code === "vault_migrate_required") {
              await this.migrateEncryptContext(contextId);
              batchInput = appendInputWithoutClientIds(input);
              continue;
            }
            if (status === 409) {
              await client.get(contextId);
              const snap = await this.get(contextId);
              if (encrypted) {
                const deduped = appendResponseFromExistingHead(snap, encrypted);
                if (deduped) return deduped;
              }
              if (attempt >= APPEND_CONFLICT_MAX_ATTEMPTS - 1) throw error;
              batchInput = appendInputWithoutClientIds(input);
              await sleep(Math.min(2000, 50 * 2 ** attempt));
              continue;
            }
            throw error;
          }
        }
        throw new Error("Vault append failed after conflict retries");
      });
    },

    async get(idOrOptions, options) {
      if (!idOrOptions || typeof idOrOptions === "object") {
        const res = await client.get(idOrOptions);
        res.data = res.data.map((row) => ({
          id: row.id,
          created_at: row.created_at,
          metadata: decryptRootMetadata(row.metadata ?? {}, ctx),
        }));
        return res;
      }
      ctx.contextId = idOrOptions;
      const res = await client.get(idOrOptions, options);
      return mapGetResponse(res, idOrOptions);
    },

    async update(contextId, input, options) {
      ctx.contextId = contextId;
      const snap = await this.get(contextId);
      const rows = snap?.data ?? [];
      const rawUpdates = Array.isArray(input) ? input : input?.updates ?? [input];

      function resolveRow(msg) {
        if (msg.id !== undefined) return rows.find((row) => row.id === msg.id);
        if (msg.index !== undefined) {
          let idx = msg.index;
          if (idx < 0) idx = rows.length + idx;
          return rows[idx];
        }
        throw new Error("Vault update requires message id or index");
      }

      const encrypted = rawUpdates.map((msg) => {
        const row = resolveRow(msg);
        if (!row) throw new Error("Vault update target message not found in current snapshot");
        const aadNodeId = stableNodeId(row);
        if (!isClientNodeId(aadNodeId)) {
          throw new Error("Vault update requires metadata.ic_client_node_id (icn_*) on the stored message");
        }
        const {
          id: _rowId,
          index: _rowIndex,
          metadata: existingMeta,
          decrypt_error: _de,
          ...existingBody
        } = row;
        const {
          metadata: patchMeta,
          id: _patchId,
          index: _patchIndex,
          ...patchBody
        } = msg;
        const mergedMetadata =
          patchMeta && typeof patchMeta === "object"
            ? { ...(existingMeta ?? {}), ...patchMeta }
            : { ...(existingMeta ?? {}) };
        const mergedMessage = {
          ...existingBody,
          ...patchBody,
          metadata: mergedMetadata,
        };
        const { content, metadata } = encryptMessageFields(mergedMessage, ctx, contextId, aadNodeId);
        return {
          ...content,
          id: row.id,
          ...(msg.index !== undefined ? { index: msg.index } : {}),
          metadata,
        };
      });
      let body =
        input?.updates || (options?.metadata ?? input?.metadata)
          ? {
              updates: encrypted,
              ...(options?.metadata ?? input?.metadata
                ? {
                    metadata: encryptNodeMetadata(
                      ctx.dek,
                      ctx.dekVersion,
                      options?.metadata ?? input?.metadata,
                      { contextId, userPublicId: ctx.userPublicId },
                    ),
                  }
                : {}),
            }
          : encrypted.length === 1
            ? encrypted[0]
            : encrypted;
      if (options?.base_sequence !== undefined && body && typeof body === "object" && !Array.isArray(body)) {
        body = { ...body, base_sequence: options.base_sequence };
      }
      const res = await client.update(contextId, body, options);
      return mapGetResponse(res, contextId);
    },

    async delete(contextId, input, options) {
      ctx.contextId = contextId;
      let nextOptions = options;
      if (options?.metadata) {
        nextOptions = {
          ...options,
          metadata: encryptNodeMetadata(ctx.dek, ctx.dekVersion, options.metadata, {
            contextId,
            userPublicId: ctx.userPublicId,
          }),
        };
      }
      const res = await client.delete(contextId, input, nextOptions);
      if (res?.data?.length) return mapGetResponse(res, contextId);
      return res;
    },

    async deleteMany(ids) {
      return client.deleteMany(ids);
    },

    async migrateEncryptContext(contextId) {
      ctx.contextId = contextId;
      const beforeHead = await withRateLimitRetry(() =>
        client.get(contextId, { history: true, vaultMigrateRead: true }),
      );
      const rows = beforeHead?.data ?? [];
      const plaintextRows = rows.filter((row) => !isEncryptedContent(row));
      if (plaintextRows.length === 0) {
        if (typeof client.prunePlaintextVersions === "function") {
          await client.prunePlaintextVersions(contextId);
        }
        return { encrypted: true, id: contextId, skipped: true };
      }
      const batchUpdates = plaintextRows.map((row) => {
        const existingClientId = row?.metadata?.ic_client_node_id;
        const nodeId =
          typeof existingClientId === "string" && isClientNodeId(existingClientId)
            ? existingClientId
            : generateClientNodeId();
        const { content, metadata } = encryptMessageFields(
          { ...row, metadata: withClientNodeId(row.metadata, nodeId) },
          ctx,
          contextId,
          nodeId,
        );
        return { index: row.index, ...content, metadata };
      });
      await client.update(contextId, { updates: batchUpdates });
      if (typeof client.prunePlaintextVersions === "function") {
        await withRateLimitRetry(() => client.prunePlaintextVersions(contextId));
      }
      const after = await withRateLimitRetry(() => client.get(contextId));
      for (const row of after.data ?? []) {
        const violations = [];
        if (!isEncryptedContent(row)) violations.push("plaintext content");
        if (row.role || row.text || row.content) violations.push("plaintext body fields");
        if (violations.length) {
          throw new Error(`Migration verification failed at index ${row.index}: ${violations.join(", ")}`);
        }
      }
      const withHistory = await client.get(contextId, { history: true });
      const versionCount = withHistory?.versions?.length ?? 1;
      for (let v = 0; v < versionCount; v += 1) {
        const snap = await client.get(contextId, { version: v });
        for (const row of snap.data ?? []) {
          if (!isEncryptedContent(row)) {
            throw new Error(`Migration verification failed: version ${v} still has plaintext`);
          }
        }
      }
      return {
        encrypted: true,
        id: contextId,
        migrated: batchUpdates.length,
        versionBefore: beforeHead?.version ?? null,
        versionAfter: after?.version ?? null,
      };
    },
  };
}
