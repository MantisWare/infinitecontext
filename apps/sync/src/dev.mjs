// dev entry — boots daemon in background + TUI in foreground (mirrors prod)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// skip update check in dev
process.env.INFINITECONTEXT_DEV = "1";

// spawn daemon with --watch in background
const daemon = spawn("node", ["--watch", path.join(__dirname, "index.mjs")], {
  stdio: ["ignore", "pipe", "pipe"],
  env: process.env,
});

// suppress daemon output (TUI owns the terminal)
daemon.unref();

// boot TUI in foreground (wait until daemon lock or status file appears)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

await import("./env.mjs");
const statusFile = path.join(os.homedir(), ".infinitecontext", "status.json");
const lockFile = path.join(os.homedir(), ".infinitecontext", "daemon.lock");
const deadline = Date.now() + 15_000;
while (Date.now() < deadline) {
  if (fs.existsSync(statusFile) || fs.existsSync(lockFile)) break;
  await new Promise((r) => setTimeout(r, 50));
}

const { tuiBoot } = await import("./tui.mjs");
const { resolveHostAuthHooks } = await import("./host-auth.mjs");
const auth = await resolveHostAuthHooks();
await tuiBoot({ ...auth });
