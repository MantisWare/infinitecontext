const TEST_HOOK_ENV_NAMES = {
  raceDoubleWin: "INFINITECONTEXT_S3_CAS_RACE_DOUBLE_WIN_TEST",
  keyringProbeForce: "INFINITECONTEXT_KEYRING_PROBE_FORCE",
};

/**
 * @param {keyof typeof TEST_HOOK_ENV_NAMES | string} name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | undefined}
 */
export function readTestHook(name, env = process.env) {
  if (env.NODE_ENV !== "test") {
    return undefined;
  }
  const envName = TEST_HOOK_ENV_NAMES[/** @type {keyof typeof TEST_HOOK_ENV_NAMES} */ (name)];
  if (!envName) {
    return undefined;
  }
  const value = env[envName];
  return value === undefined ? undefined : String(value);
}

/** @param {NodeJS.ProcessEnv} [env] */
export function isTestRuntime(env = process.env) {
  return env.NODE_ENV === "test";
}

/**
 * @param {{ testHooks?: { raceDoubleWin?: boolean | string | number } }} [options]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function isRaceDoubleWinTestActive(options = {}, env = process.env) {
  const injected = options.testHooks?.raceDoubleWin;
  if (injected !== undefined && injected !== null && injected !== false && injected !== "") {
    return injected === true || String(injected) === "1";
  }
  return String(readTestHook("raceDoubleWin", env) ?? "") === "1";
}

/**
 * @param {Record<string, unknown> | undefined} options
 * @param {string} hookField
 * @param {NodeJS.ProcessEnv} [env]
 */
export function isInjectedTestHookActive(options, hookField, env = process.env) {
  if (!isTestRuntime(env)) {
    return false;
  }
  if (!options || typeof options !== "object") {
    return false;
  }
  const value = options[hookField];
  if (value === undefined || value === null || value === false) {
    return false;
  }
  if (typeof value === "function") {
    return true;
  }
  if (hookField === "testHookSkipLocalSaveAfterSegmentWrite") {
    return value === true;
  }
  return Boolean(value);
}
