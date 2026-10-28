import { listActiveInheritedMutantEnvKeys } from "./premerge-env.mjs";

/** @typedef {"M1" | "M1b" | "M2" | "M3" | "M6" | "M7" | "B1"} PremergeMutantId */

const ALLOWED = /** @type {Set<PremergeMutantId>} */ (
  new Set(["M1", "M1b", "M2", "M3", "M6", "M7", "B1"])
);

/**
 * Mutants are test-only. Set `IC_PREMERGE_ALLOW_MUTANT=1` only under committed-mutant runner or fixtures.
 */
export function premergeMutantsEnabled() {
  return String(process.env.IC_PREMERGE_ALLOW_MUTANT ?? "").trim() === "1";
}

/**
 * @returns {Set<PremergeMutantId>}
 */
export function parsePremergeMutants() {
  if (!premergeMutantsEnabled()) {
    return new Set();
  }
  const raw = String(process.env.PREMERGE_MUTANT ?? "").trim();
  if (!raw) {
    return new Set();
  }
  /** @type {Set<PremergeMutantId>} */
  const out = new Set();
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (id && ALLOWED.has(/** @type {PremergeMutantId} */ (id))) {
      out.add(/** @type {PremergeMutantId} */ (id));
    }
  }
  return out;
}

/**
 * @param {PremergeMutantId} id
 */
export function hasPremergeMutant(id) {
  return parsePremergeMutants().has(id);
}

/**
 * Real premerge refuses inherited mutant/test hooks unless the committed-mutant runner owns the process.
 * @param {Record<string, string | undefined>} env
 */
export function assertPremergeProductionMutantPolicy(env) {
  const runner = String(env.IC_PREMERGE_COMMITTED_MUTANT_RUNNER ?? "").trim() === "1";
  const inherited = listActiveInheritedMutantEnvKeys(env);
  if (runner) {
    if (inherited.length > 0 || premergeMutantsEnabled()) {
      const active = String(env.PREMERGE_MUTANT ?? "").trim() || "(allow only)";
      console.error(`premerge: MUTANT ACTIVE (committed-mutant runner): ${active}`);
    }
    return;
  }
  if (inherited.length > 0) {
    throw new Error(
      `premerge refuses inherited mutant/test env (${inherited.join(", ")}) — only premerge-committed-mutant-runner.mjs may set these`,
    );
  }
}

/**
 * @deprecated use assertPremergeProductionMutantPolicy at premerge entry
 */
export function sanitizePremergeProductionEnv() {
  assertPremergeProductionMutantPolicy(process.env);
}
