import {
  DecryptionFailedError,
  decryptNodeContent,
  decryptNodeMetadata,
  encryptNodeContent,
  encryptNodeMetadata,
  isEncryptedContent,
  pickCleartextMetadata,
} from "./ic-crypto.mjs";

import { randomRootAadNonce } from "./vault-agent.mjs";

function messageAadBase(ctx, contextId, nodeIndex) {
  return {
    contextId,
    userPublicId: ctx.userPublicId,
    dekVersion: ctx.dekVersion,
    nodeIndex,
  };
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

function encryptMessageFields(message, ctx, contextId, nodeIndex) {
  const { metadata, id: _id, index: _index, ...content } = message;
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  const binding = messageAadBase(ctx, contextId, nodeIndex);
  return {
    content: encryptNodeContent(ctx.dek, ctx.dekVersion, content, binding),
    metadata: encryptNodeMetadata(ctx.dek, ctx.dekVersion, meta, binding),
  };
}

function decryptMessageRow(row, ctx, contextId, { allowPlaintext = false } = {}) {
  const binding = messageAadBase(ctx, contextId, row.index);
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
  const list = await client.get({ limit: 500 });
  const row = list?.data?.find((c) => c.id === sourceContextId);
  return row?.metadata ?? {};
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
            nodeIndex: row.index,
          })
        : {};
    const { content, metadata } = encryptMessageFields(
      { ...plaintext, metadata: meta },
      ctx,
      newContextId,
      row.index,
    );
    updates.push({ index: row.index, ...content, metadata });
  }
  if (updates.length > 0) {
    await client.update(newContextId, { updates });
  }
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
      const head = await client.get(contextId);
      const baseIndex = head?.data?.length ?? 0;
      const items = Array.isArray(input) ? input : [input];
      const encrypted = items.map((msg, offset) => {
        const nodeIndex = baseIndex + offset;
        const { content, metadata } = encryptMessageFields(msg, ctx, contextId, nodeIndex);
        return { ...content, metadata };
      });
      const res = await client.append(contextId, encrypted.length === 1 ? encrypted[0] : encrypted);
      res.data = res.data.map((row) => decryptMessageRow(row, ctx, contextId, { allowPlaintext }));
      return res;
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
      res.data = res.data.map((row) => decryptMessageRow(row, ctx, idOrOptions, { allowPlaintext }));
      return res;
    },

    async update(contextId, input, options) {
      ctx.contextId = contextId;
      const rawUpdates = Array.isArray(input) ? input : input?.updates ?? [input];
      const needsIndexLookup = rawUpdates.some((msg) => msg.index === undefined && msg.id);
      const indexById = new Map();
      if (needsIndexLookup) {
        const snap = await client.get(contextId);
        for (const row of snap.data ?? []) indexById.set(row.id, row.index);
      }
      const encrypted = rawUpdates.map((msg) => {
        const nodeIndex = msg.index ?? indexById.get(msg.id);
        const { content, metadata } = encryptMessageFields(msg, ctx, contextId, nodeIndex);
        return {
          ...content,
          ...(msg.id ? { id: msg.id } : {}),
          ...(msg.index !== undefined ? { index: msg.index } : {}),
          metadata,
        };
      });
      const body =
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
      const res = await client.update(contextId, body, options?.metadata ? undefined : options);
      res.data = res.data.map((row) => decryptMessageRow(row, ctx, contextId, { allowPlaintext }));
      return res;
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
      return client.delete(contextId, input, nextOptions);
    },

    async deleteMany(ids) {
      return client.deleteMany(ids);
    },

    async migrateEncryptContext(contextId) {
      ctx.contextId = contextId;
      const beforeHead = await client.get(contextId, { history: true });
      const rows = beforeHead?.data ?? [];
      const plaintextIndices = rows.filter((row) => !isEncryptedContent(row)).map((row) => row.index);
      if (plaintextIndices.length === 0) {
        return { encrypted: true, id: contextId, skipped: true };
      }
      const updates = plaintextIndices.map((index) => {
        const row = rows.find((r) => r.index === index);
        const { content, metadata } = encryptMessageFields(row, ctx, contextId, index);
        return { index, ...content, metadata };
      });
      await client.update(contextId, { updates });
      const after = await client.get(contextId);
      for (const row of after.data ?? []) {
        if (!isEncryptedContent(row)) {
          throw new Error(`Migration verification failed: message index ${row.index} still plaintext`);
        }
      }
      return {
        encrypted: true,
        id: contextId,
        migrated: updates.length,
        versionBefore: beforeHead?.version ?? null,
        versionAfter: after?.version ?? null,
      };
    },
  };
}
