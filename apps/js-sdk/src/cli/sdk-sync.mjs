// SDK sync entry-point — wires store + boots daemon without dotenv
// NOTE: parsers are re-exported here so the TUI bundle can import them
// from this chunk. The daemonBoot() call MUST be guarded so importing
// this module for parsers alone doesn't start a second daemon.
import { importSync } from "../../lib/sync-import.mjs";
import { syncHostAuth } from "./sync-host.mjs";

const { createStore, resolveDbPath } = await importSync("store");
const { daemonBoot } = await importSync("sync");

// only boot when spawned as daemon child (launcher passes --daemon)
if (process.argv.includes("--daemon")) {
  daemonBoot({ createStore, resolveDbPath, ...syncHostAuth });
}
