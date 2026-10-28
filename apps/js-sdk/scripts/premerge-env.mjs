/**
 * Leg child env for premerge.mjs — strips test/mutant keys from the parent snapshot.
 * @param {Record<string, string | undefined>} parentEnv
 * @param {{
 *   premergeHome: string;
 *   premergeTmpRoot: string;
 *   vaultPidRegistryPath: string;
 *   forceNoPty?: boolean;
 * }} paths
 * @param {Record<string, string | undefined>} [extra]
 */
export function buildPremergeLegEnv(parentEnv, paths, extra = {}) {
  const forceNoPty =
    String(parentEnv.IC_PREMERGE_FORCE_NO_PTY ?? "").trim() === "1" || Boolean(paths.forceNoPty);
  /** @type {Record<string, string | undefined>} */
  const env = { ...parentEnv };
  delete env.PREMERGE_MUTANT;
  delete env.PREMERGE_TEST_REVERT_B1;
  delete env.PREMERGE_TEST_B1_SIGINT_DELAY_MS;
  delete env.PREMERGE_TEST_B1_SIGINT_OFFSET_MS;
  delete env.IC_PREMERGE_ALLOW_MUTANT;
  delete env.IC_PREMERGE_COMMITTED_MUTANT_RUNNER;
  return {
    ...env,
    HOME: paths.premergeHome,
    IC_PREMERGE_HOME: paths.premergeHome,
    IC_PREMERGE_VAULT_PID_REGISTRY: paths.vaultPidRegistryPath,
    TMPDIR: paths.premergeTmpRoot,
    TMP: paths.premergeTmpRoot,
    TEMP: paths.premergeTmpRoot,
    IC_PREMERGE_TMPDIR: paths.premergeTmpRoot,
    DISABLE_V8_COMPILE_CACHE: "1",
    ...(forceNoPty ? { IC_PREMERGE_FORCE_NO_PTY: "1" } : {}),
    ...extra,
  };
}

/** Keys that must not be inherited into a real premerge run. */
export const PREMERGE_INHERITED_MUTANT_ENV_KEYS = [
  "IC_PREMERGE_ALLOW_MUTANT",
  "PREMERGE_MUTANT",
  "PREMERGE_TEST_REVERT_B1",
  "PREMERGE_TEST_B1_SIGINT_DELAY_MS",
  "PREMERGE_TEST_B1_SIGINT_OFFSET_MS",
];

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function listActiveInheritedMutantEnvKeys(env) {
  /** @type {string[]} */
  const found = [];
  for (const key of PREMERGE_INHERITED_MUTANT_ENV_KEYS) {
    const raw = String(env[key] ?? "").trim();
    if (!raw) {
      continue;
    }
    found.push(key === "PREMERGE_MUTANT" ? `${key}=${raw}` : key);
  }
  return found;
}
