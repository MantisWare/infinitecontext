import fs from "node:fs";

const marker = process.env.PREMERGE_TRAP_MARKER;
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

setTimeout(() => {}, 60_000);
