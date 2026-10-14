import { spawn, spawnSync } from "node:child_process";

import { StorageError } from "./errors.mjs";

const DEFAULT_DBUS_TIMEOUT_MS = 2_000;
const SECRET_SERVICE_WELL_KNOWN = "org.freedesktop.secrets";

/** @returns {boolean} */
function isDbusSendAvailable() {
  if (process.platform === "win32") {
    return spawnSync("where", ["dbus-send"], { stdio: "ignore" }).status === 0;
  }
  return spawnSync("sh", ["-c", "command -v dbus-send"], { stdio: "ignore" }).status === 0;
}

/**
 * @throws {StorageError} when Linux Secret Service checks need dbus-send but it is missing
 */
export function assertDbusSendAvailableOnLinux() {
  if (process.platform !== "linux") {
    return;
  }
  if (!isDbusSendAvailable()) {
    throw new StorageError(
      "Linux Secret Service detection requires the dbus-send CLI (D-Bus tools package). Install dbus-x11 or dbus.",
      "not_supported",
    );
  }
}

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
  if (!isDbusSendAvailable()) {
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

    child.on("error", (error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        finish(false);
        return;
      }
      finish(false);
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        finish(false);
        return;
      }
      finish(/boolean\s+true/i.test(stdout));
    });
  });
}

/**
 * Like {@link isLinuxSecretServiceOnSessionBus} but throws when dbus-send is missing on Linux.
 * @param {number} [timeoutMs]
 */
export async function requireLinuxSecretServiceOnSessionBus(timeoutMs = DEFAULT_DBUS_TIMEOUT_MS) {
  assertDbusSendAvailableOnLinux();
  return isLinuxSecretServiceOnSessionBus(timeoutMs);
}
