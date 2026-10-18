import { Entry } from "@napi-rs/keyring";

import { isLinuxSecretServiceOnSessionBus } from "./secret-store-linux-dbus.mjs";
import { SECRET_STORE_SERVICE } from "./secret-store-constants.mjs";

import { readTestHook } from "./test-hooks.mjs";

if (readTestHook("keyringProbeForce", process.env) === "fail") {
  process.exit(1);
}

if (process.platform === "linux") {
  const ok = await isLinuxSecretServiceOnSessionBus();
  if (!ok) {
    process.exit(1);
  }
}

const linuxOptions = process.platform === "linux" ? { linux: { store: "secret-service" } } : undefined;

const probeName = `__ic_ss_probe_${process.pid}_${Date.now()}`;
const entry = new Entry(SECRET_STORE_SERVICE, probeName, linuxOptions);
entry.setSecret(new Uint8Array([0x1c]));
entry.deleteCredential();
