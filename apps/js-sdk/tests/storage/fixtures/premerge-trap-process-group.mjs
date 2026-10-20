import { spawn } from "node:child_process";
import fs from "node:fs";

const marker = process.env.PREMERGE_TRAP_MARKER;
const ready = process.env.PREMERGE_TRAP_READY;
const sleeper = process.env.PREMERGE_TRAP_SLEEPER;
if (!marker || !sleeper) {
  process.exit(2);
}

/** @type {import("node:child_process").ChildProcess | null} */
let grandchild = null;

function killGrandchildGroup() {
  if (!grandchild?.pid) {
    return;
  }
  try {
    process.kill(-grandchild.pid, "SIGTERM");
  } catch {
    try {
      grandchild.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
}

function cleanup() {
  killGrandchildGroup();
  fs.writeFileSync(marker, "down\n");
}

grandchild = spawn(process.execPath, [sleeper], {
  detached: true,
  stdio: "ignore",
});
grandchild.unref();

process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

if (ready) {
  fs.writeFileSync(ready, "ready\n");
}

setTimeout(() => {}, 60_000);
