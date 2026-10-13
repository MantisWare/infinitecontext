import { Entry } from "@napi-rs/keyring";

import { SECRET_STORE_SERVICE } from "./secret-store-constants.mjs";

if (process.env.INFINITECONTEXT_KEYRING_PROBE_FORCE === "fail") {
  process.exit(1);
}

const probeName = `__ic_ss_probe_${process.pid}_${Date.now()}`;
const entry = new Entry(SECRET_STORE_SERVICE, probeName);
entry.setSecret(new Uint8Array([0x1c]));
entry.deleteCredential();
