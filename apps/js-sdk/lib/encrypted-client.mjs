import {
  DecryptionFailedError,
  decryptNodeContent,
  decryptNodeMetadata,
  encryptNodeContent,
  encryptNodeMetadata,
  isEncryptedContent,
  pickCleartextMetadata,
} from "@infinitecontext/crypto";

import { randomRootAadNonce } from "./vault-agent.mjs";

function messageAadBase(ctx, contextId, row) {
  return {
    contextId,
    userPublicId: ctx.userPublicId,
    dekVersion: ctx.dekVersion,
    nodePublicId: row?.id ?? row?.nodePublicId,
    nodeIndex: row?.index,
  };
}

function encryptMessageFields(message, ctx, contextId) {
  const { metadata, id, index, ...content } = message;
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  const binding = messageAadBase(ctx, contextId, { id, index: index ?? message.nodeIndex });
  return {
    content: encryptNodeContent(ctx.dek, ctx.dekVersion, content, binding),
    metadata: encryptNodeMetadata(ctx.dek, ctx.dekVersion, meta, binding),
  };
}

function decryptMessageRow(row, ctx, contextId, { allowPlaintext = false } = {}) {
  const binding = messageAadBase(ctx, contextId, row);
  try {
    let body;
    if (isEncryptedContent(row)) {
      body = decryptNodeContent(ctx.dek, row, binding, { allowPlaintext });
    } else if (allowPlaintext) {
      body = row;
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

function prepareRootMetadata(metadata, ctx, contextId) {
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
    { contextId, userPublicId: ctx.userPublicId },
    { rootMetadata: true },
  );
}

function decryptRootMetadata(metadata, ctx, contextId) {
  try {
    return decryptNodeMetadata(
      ctx.dek,
      metadata ?? {},
      { contextId, userPublicId: ctx.userPublicId },
      { rootMetadata: true },
    );
  } catch (error) {
    return {
      ...(metadata ?? {}),
      decrypt_error: error instanceof DecryptionFailedError ? error.message : "Failed to decrypt context metadata",
    };
  }
}

async function rebindForkedContext(client, ctx, newContextId, sourceContextId) {
  const res = await client.get(newContextId);
  const updates = [];
  for (const row of res.data ?? []) {
    if (!isEncryptedContent(row)) continue;
    let plaintext;
    try {
      plaintext = decryptNodeContent(ctx.dek, row, {
        contextId: sourceContextId,
        userPublicId: ctx.userPublicId,
        dekVersion: ctx.dekVersion,
        nodePublicId: row.id,
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
            nodePublicId: row.id,
            nodeIndex: row.index,
          })
        : {};
    const { content, metadata } = encryptMessageFields(
      { ...plaintext, metadata: meta, index: row.index },
      ctx,
      newContextId,
    );
    updates.push({ index: row.index, ...content, metadata });
  }
  if (updates.length === 0) return;
  await client.update(newContextId, { updates });
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
      const metadata = prepareRootMetadata(input.metadata ?? {}, ctx, "pending");
      const res = await client.create({ ...input, metadata });
      ctx.contextId = res.id;
      if (res.metadata) {
        res.metadata = decryptRootMetadata(res.metadata, ctx, res.id);
      }
      if (sourceId) {
        await rebindForkedContext(client, ctx, res.id, sourceId);
        const refreshed = await client.get(res.id);
        refreshed.data = (refreshed.data ?? []).map((row) => decryptMessageRow(row, ctx, res.id, { allowPlaintext }));
        return { ...res, ...refreshed, id: res.id, metadata: res.metadata };
      }
      return res;
    },

    async append(contextId, input) {
      ctx.contextId = contextId;
      const head = await client.get(contextId);
      const baseIndex = head?.data?.length ?? 0;
      const items = Array.isArray(input) ? input : [input];
      const encrypted = items.map((msg, offset) => {
        const { content, metadata } = encryptMessageFields(
          { ...msg, index: baseIndex + offset },
          ctx,
          contextId,
        );
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
          metadata: decryptRootMetadata(row.metadata ?? {}, ctx, row.id),
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
      const updates = Array.isArray(input) ? input : input?.updates ?? [input];
      const encrypted = updates.map((msg) => {
        const { content, metadata } = encryptMessageFields(msg, ctx, contextId);
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

    async migrateEncryptContext(contextId, { purgePlaintextHeads = true } = {}) {
      ctx.contextId = contextId;
      const beforeHead = await client.get(contextId, { history: true });
      const rows = beforeHead?.data ?? [];
      const plaintextIndices = [];
      for (const row of rows) {
        if (!isEncryptedContent(row)) plaintextIndices.push(row.index);
      }
      if (plaintextIndices.length === 0) {
        return { encrypted: true, id: contextId, skipped: true };
      }
      const updates = plaintextIndices.map((index) => {
        const row = rows.find((r) => r.index === index);
        const { content, metadata } = encryptMessageFields(row, ctx, contextId);
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
