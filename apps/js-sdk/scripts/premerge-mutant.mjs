/** @typedef {"M1" | "M1b" | "M2" | "M3" | "M6" | "M7"} PremergeMutantId */

const ALLOWED = /** @type {Set<PremergeMutantId>} */ (
  new Set(["M1", "M1b", "M2", "M3", "M6", "M7"])
);

/**
 * Mutants are test-only. Set `IC_PREMERGE_ALLOW_MUTANT=1` in tests or campaign fixtures.
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
 * Strip test-only env that must not affect normal premerge runs.
 */
export function sanitizePremergeProductionEnv() {
  if (premergeMutantsEnabled()) {
    return;
  }
  delete process.env.PREMERGE_MUTANT;
  delete process.env.PREMERGE_TEST_REVERT_B1;
}
