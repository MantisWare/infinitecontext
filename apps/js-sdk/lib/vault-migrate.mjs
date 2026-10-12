import fs from "node:fs";
import path from "node:path";

import { isEncryptedContent } from "@infinitecontext/crypto";

import { infinitecontextHome } from "./credentials.mjs";

function statePath(scopeKey) {
  const safe = String(scopeKey).replace(/[^a-zA-Z0-9._-]+/g, "_");
  return path.join(infinitecontextHome(), `vault-migrate-${safe}.json`);
}

export function loadMigrateState(scopeKey) {
  try {
    return JSON.parse(fs.readFileSync(statePath(scopeKey), "utf8"));
  } catch {
    return { completedContextIds: [], updatedAt: null };
  }
}

export function saveMigrateState(scopeKey, state) {
  const dir = infinitecontextHome();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    statePath(scopeKey),
    `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

export function listPlaintextMessages(contextResponse) {
  const rows = contextResponse?.data ?? [];
  return rows.filter((row) => !isEncryptedContent(row));
}

export async function migrateProjectEncryption({
  scopeKey,
  listContexts,
  encryptContext,
  dryRun = false,
}) {
  const state = loadMigrateState(scopeKey);
  const completed = new Set(state.completedContextIds ?? []);
  const listing = await listContexts({ limit: 500 });
  const contexts = listing?.data ?? [];

  const report = {
    dryRun,
    totalContexts: contexts.length,
    pending: [],
    completed: [...completed],
    encryptedThisRun: [],
    skippedAlreadyEncrypted: [],
  };

  for (const ctx of contexts) {
    const id = String(ctx.id);
    if (completed.has(id)) continue;
    report.pending.push(id);
    if (dryRun) continue;
    const result = await encryptContext(id);
    if (result?.encrypted) {
      completed.add(id);
      report.encryptedThisRun.push(id);
      saveMigrateState(scopeKey, { completedContextIds: [...completed] });
    }
  }

  report.completed = [...completed];
  return report;
}
