import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { isLinuxSecretServiceOnSessionBus } from "./secret-store-linux-dbus.mjs";

const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
const PROBE_CHILD = fileURLToPath(new URL("./secret-store-keyring-probe-child.mjs", import.meta.url));

/** @type {boolean | undefined} */
let cachedProbeResult;

/** @type {boolean} */
let keyringProbeForceFailForTests = false;

/** @param {boolean} active */
export function setKeyringProbeForceFailForTests(active) {
  keyringProbeForceFailForTests = active === true;
}

/** Clears per-process probe cache (tests only). */
export function resetKeyringProbeCacheForTests() {
  cachedProbeResult = undefined;
}

/**
 * Non-interactive probe: on Linux requires session D-Bus Secret Service, then set/delete via secret-service store only.
 * @param {number} [timeoutMs]
 */
export async function probeKeyringSecretService(timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  if (cachedProbeResult !== undefined) {
    return cachedProbeResult;
  }
  cachedProbeResult = await probeKeyringSecretServiceOnce(timeoutMs);
  return cachedProbeResult;
}

/**
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function probeKeyringSecretServiceOnce(timeoutMs) {
  if (process.platform === "linux") {
    if (!(await isLinuxSecretServiceOnSessionBus(timeoutMs))) {
      return false;
    }
  }
  return runKeyringProbeChild(timeoutMs);
}

/**
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function runKeyringProbeChild(timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const probeArgs = keyringProbeForceFailForTests ? [PROBE_CHILD, "--force-fail"] : [PROBE_CHILD];
    const child = spawn(process.execPath, probeArgs, {
      env: process.env,
      stdio: "ignore",
    });

    const finish = (ok) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      finish(false);
    }, timeoutMs);

    child.on("error", () => finish(false));
    child.on("exit", (code) => finish(code === 0));
  });
}
