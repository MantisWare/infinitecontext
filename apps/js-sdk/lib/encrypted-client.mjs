import {
  decryptNodeContent,
  decryptNodeMetadata,
  encryptNodeContent,
  encryptNodeMetadata,
  isEncryptedContent,
} from "@infinitecontext/crypto";

function encryptMessageFields(message, ctx) {
  const { metadata, ...content } = message;
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  const aadBase = {
    contextId: ctx.contextId ?? "new",
    userPublicId: ctx.userPublicId,
    dekVersion: ctx.dekVersion,
  };
  return {
    content: encryptNodeContent(ctx.dek, ctx.dekVersion, content, aadBase),
    metadata: encryptNodeMetadata(ctx.dek, ctx.dekVersion, meta, aadBase),
  };
}

function decryptMessageRow(row, ctx) {
  const aadBase = {
    contextId: ctx.contextId,
    userPublicId: ctx.userPublicId,
    dekVersion: ctx.dekVersion,
  };
  let body = row;
  if (isEncryptedContent(row)) {
    body = decryptNodeContent(ctx.dek, row, aadBase);
  }
  const metadata =
    row?.metadata && typeof row.metadata === "object"
      ? decryptNodeMetadata(ctx.dek, row.metadata, aadBase)
      : (row?.metadata ?? {});
  return { ...body, id: row.id, index: row.index, metadata };
}

export function wrapInfiniteContextWithVault(client, vaultCtx) {
  if (!vaultCtx?.dek) return client;

  const ctx = {
    dek: vaultCtx.dek,
    dekVersion: vaultCtx.dekVersion ?? 1,
    userPublicId: vaultCtx.userPublicId,
    contextId: null,
  };

  return {
    ...client,
    async create(input = {}) {
      const metadata = input.metadata ?? {};
      const encMeta = encryptNodeMetadata(ctx.dek, ctx.dekVersion, metadata, {
        contextId: "new",
        userPublicId: ctx.userPublicId,
        dekVersion: ctx.dekVersion,
      });
      const res = await client.create({ ...input, metadata: encMeta });
      ctx.contextId = res.id;
      if (res.metadata) {
        res.metadata = decryptNodeMetadata(ctx.dek, res.metadata, {
          contextId: res.id,
          userPublicId: ctx.userPublicId,
          dekVersion: ctx.dekVersion,
        });
      }
      return res;
    },

    async append(contextId, input) {
      ctx.contextId = contextId;
      const items = Array.isArray(input) ? input : [input];
      const encrypted = items.map((msg) => {
        const { content, metadata } = encryptMessageFields(msg, { ...ctx, contextId });
        return { ...content, metadata };
      });
      const res = await client.append(contextId, encrypted.length === 1 ? encrypted[0] : encrypted);
      res.data = res.data.map((row) => decryptMessageRow(row, { ...ctx, contextId }));
      return res;
    },

    async get(idOrOptions, options) {
      if (!idOrOptions || typeof idOrOptions === "object") {
        const res = await client.get(idOrOptions);
        res.data = res.data.map((row) => ({
          id: row.id,
          created_at: row.created_at,
          metadata: decryptNodeMetadata(ctx.dek, row.metadata ?? {}, {
            contextId: row.id,
            userPublicId: ctx.userPublicId,
            dekVersion: ctx.dekVersion,
          }),
        }));
        return res;
      }
      ctx.contextId = idOrOptions;
      const res = await client.get(idOrOptions, options);
      res.data = res.data.map((row) => decryptMessageRow(row, { ...ctx, contextId: idOrOptions }));
      return res;
    },

    async update(contextId, input, options) {
      ctx.contextId = contextId;
      const updates = Array.isArray(input) ? input : [input];
      const encrypted = updates.map((msg) => {
        const { content, metadata } = encryptMessageFields(msg, { ...ctx, contextId });
        return { ...content, ...(msg.id ? { id: msg.id } : {}), ...(msg.index !== undefined ? { index: msg.index } : {}), metadata };
      });
      const body = options?.metadata
        ? {
            updates: encrypted,
            metadata: encryptNodeMetadata(ctx.dek, ctx.dekVersion, options.metadata, {
              contextId,
              userPublicId: ctx.userPublicId,
              dekVersion: ctx.dekVersion,
            }),
          }
        : encrypted.length === 1
          ? encrypted[0]
          : encrypted;
      const res = await client.update(contextId, body, options?.metadata ? undefined : options);
      res.data = res.data.map((row) => decryptMessageRow(row, { ...ctx, contextId }));
      return res;
    },

    async delete(contextId, input, options) {
      ctx.contextId = contextId;
      if (options?.metadata) {
        options = {
          ...options,
          metadata: encryptNodeMetadata(ctx.dek, ctx.dekVersion, options.metadata, {
            nodePublicId: contextId,
            contextId,
            userPublicId: ctx.userPublicId,
            dekVersion: ctx.dekVersion,
          }),
        };
      }
      return client.delete(contextId, input, options);
    },

    async deleteMany(ids) {
      return client.deleteMany(ids);
    },

    /** Opt-in migration: encrypt existing plaintext nodes in place. */
    async migrateEncryptContext(contextId) {
      ctx.contextId = contextId;
      const res = await client.get(contextId);
      for (const row of res.data) {
        if (isEncryptedContent(row)) continue;
        const { content, metadata } = encryptMessageFields(row, { ...ctx, contextId });
        await client.update(contextId, { id: row.id, ...content, metadata });
      }
      return { encrypted: true, id: contextId };
    },
  };
}
