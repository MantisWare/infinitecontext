/** @param {NodeJS.ProcessEnv} [env] */
export function isTestRuntime(env = process.env) {
  return env.NODE_ENV === "test";
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
  return Boolean(value);
}
