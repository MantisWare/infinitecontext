import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
const PROBE_CHILD = fileURLToPath(new URL("./secret-store-keyring-probe-child.mjs", import.meta.url));

/**
 * Non-interactive probe: set/delete a throwaway keychain entry in a child process with a deadline.
 * @param {number} [timeoutMs]
 */
export function probeKeyringSecretService(timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(process.execPath, [PROBE_CHILD], {
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
