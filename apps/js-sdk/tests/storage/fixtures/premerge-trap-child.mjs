import fs from "node:fs";

const marker = process.env.PREMERGE_TRAP_MARKER;
const ready = process.env.PREMERGE_TRAP_READY;
if (!marker) {
  process.exit(2);
}

let cleaned = false;

function cleanup() {
  if (cleaned) {
    return;
  }
  cleaned = true;
  fs.writeFileSync(marker, "down\n");
}

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
