import { spawn } from "node:child_process";

const DEFAULT_DBUS_TIMEOUT_MS = 2_000;
const SECRET_SERVICE_WELL_KNOWN = "org.freedesktop.secrets";

/**
 * Whether org.freedesktop.secrets is reachable on the session D-Bus (Linux only).
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export function isLinuxSecretServiceOnSessionBus(timeoutMs = DEFAULT_DBUS_TIMEOUT_MS) {
  if (process.platform !== "linux") {
    return Promise.resolve(true);
  }
  const address = process.env.DBUS_SESSION_BUS_ADDRESS?.trim();
  if (!address) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };

    const child = spawn(
      "dbus-send",
      [
        "--session",
        "--print-reply",
        "--dest=org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus.NameHasOwner",
        `string:${SECRET_SERVICE_WELL_KNOWN}`,
      ],
      { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      finish(false);
    }, timeoutMs);

    child.on("error", () => finish(false));
    child.on("exit", (code) => {
      if (code !== 0) {
        finish(false);
        return;
      }
      finish(/boolean\s+true/i.test(stdout));
    });
  });
}
