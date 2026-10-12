#!/usr/bin/env node

// CLI router — dispatches subcommands to daemon/tui entry points
import process from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const command = (process.argv[2] ?? "").trim().toLowerCase().replace(/^--?/, "");
const subcommand = (process.argv[3] ?? "").trim().toLowerCase().replace(/^--?/, "");
const PACKAGE_NAME = "infinitecontext";
const packageRoot = path.resolve(__dirname, "..", "..");
const cliWrapperPath = path.join(packageRoot, "infinitecontext.mjs");

// resolve package version
function readVersion() {
  try {
    const pkgPath = path.resolve(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function printHelp() {
  const version = readVersion();
  console.log(`infinitecontext v${version}

Usage: infinitecontext [command] [options]

Commands:
  (none)        Start sync (daemon + TUI)
  sync          Start sync (daemon + TUI)
  sync start    Start daemon in background (no TUI)
  sync stop     Stop a running daemon
  sync status   Show daemon status
  config        Run the setup wizard
  login         Sign in with email/password or Google OAuth
  logout        Sign out and clear local session tokens
  whoami        Show the signed-in account
  vault         Zero-knowledge vault (init, unlock, recovery, devices)
  switch        Switch session to another agent (codex, claude)
  update        Update CLI globally via npm/pnpm/bun
  version       Print version
  help          Show this help message

Environment:
  INFINITECONTEXT_API_KEY   Optional legacy API key (or run: infinitecontext login)
  INFINITECONTEXT_BASE_URL  API base URL (default: https://api.infinitecontext.ai)

Vault: Losing both your vault passphrase and recovery key means permanent data loss.
Run \`infinitecontext vault help\` for init/unlock/recover commands.
`);
}

function printUpdateHelp() {
  console.log(`Usage: infinitecontext update [options]

Options:
  --tag <dist-tag|version>       Package tag/version (default: latest)
  --manager <npm|pnpm|bun>       Force package manager (auto-detected by default)
  --no-restart                   Do not restart daemon after update
  -h, --help                     Show this help message
`);
}

// commands that need an API key
const NEEDS_KEY = new Set(["", "sync"]);

// interactive onboarding wizard (Ink-based), returns { launchTui }
async function runOnboarding() {
  const { onboard } = await import("./onboarding.mjs");
  return onboard();
}

// check if daemon is already running via lock file
function isDaemonRunning() {
  try {
    const lockPath = path.join(process.env.HOME || process.env.USERPROFILE || "~", ".infinitecontext", "daemon.lock");
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    const pid = Number.parseInt(String(lock?.pid ?? ""), 10);
    if (!Number.isInteger(pid) || pid <= 1) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// try loading key from config file if env is empty
function loadApiKeyFromConfig() {
  if (process.env.INFINITECONTEXT_API_KEY) return;
  try {
    const configPath = path.join(process.env.HOME || process.env.USERPROFILE || "~", ".infinitecontext", "config.json");
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (cfg.apiKey) process.env.INFINITECONTEXT_API_KEY = String(cfg.apiKey);
  } catch { /* no config */ }
}

async function hasSyncCredentials() {
  if (process.env.INFINITECONTEXT_API_KEY) return true;
  try {
    const { hasSessionCredentials } = await import("../../lib/credentials.mjs");
    return hasSessionCredentials();
  } catch {
    return false;
  }
}

function normalizeTag(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "latest";
  if (trimmed.startsWith(`${PACKAGE_NAME}@`)) return trimmed.slice(`${PACKAGE_NAME}@`.length);
  return trimmed;
}

function safeRealpath(targetPath) {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function pathsEqual(left, right) {
  return path.resolve(left) === path.resolve(right);
}

function runCapture(commandName, args) {
  const result = spawnSync(commandName, args, {
    env: process.env,
    encoding: "utf8",
  });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function resolveBunGlobalRoot() {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const bunInstall = String(process.env.BUN_INSTALL ?? "").trim() || path.join(home, ".bun");
  return path.join(bunInstall, "install", "global", "node_modules");
}

function detectGlobalInstallManager() {
  const packageRootReal = safeRealpath(packageRoot);
  const npmGlobalRoot = runCapture("npm", ["root", "-g"]);
  if (npmGlobalRoot.ok) {
    const npmRoot = npmGlobalRoot.stdout.trim();
    if (npmRoot) {
      const npmExpected = safeRealpath(path.join(npmRoot, PACKAGE_NAME));
      if (pathsEqual(npmExpected, packageRootReal)) return "npm";
    }
  }

  const pnpmGlobalRoot = runCapture("pnpm", ["root", "-g"]);
  if (pnpmGlobalRoot.ok) {
    const pnpmRoot = pnpmGlobalRoot.stdout.trim();
    if (pnpmRoot) {
      const pnpmExpected = safeRealpath(path.join(pnpmRoot, PACKAGE_NAME));
      if (pathsEqual(pnpmExpected, packageRootReal)) return "pnpm";
    }
  }

  const bunExpected = safeRealpath(path.join(resolveBunGlobalRoot(), PACKAGE_NAME));
  if (pathsEqual(bunExpected, packageRootReal)) return "bun";

  return null;
}

function parseUpdateOptions(args) {
  const opts = {
    tag: "latest",
    manager: null,
    restart: true,
    help: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] ?? "").trim();
    if (!arg) continue;

    if (arg === "-h" || arg === "--help") {
      opts.help = true;
      continue;
    }

    if (arg === "--no-restart") {
      opts.restart = false;
      continue;
    }

    if (arg === "--tag") {
      const next = args[i + 1];
      if (!next || String(next).startsWith("-")) {
        throw new Error("Missing value for --tag");
      }
      opts.tag = normalizeTag(next);
      i += 1;
      continue;
    }

    if (arg === "--manager") {
      const next = String(args[i + 1] ?? "").trim().toLowerCase();
      if (!next || next.startsWith("-")) {
        throw new Error("Missing value for --manager");
      }
      if (!["npm", "pnpm", "bun"].includes(next)) {
        throw new Error(`Invalid --manager value: ${next}`);
      }
      opts.manager = next;
      i += 1;
      continue;
    }

    throw new Error(`Unknown update option: ${arg}`);
  }

  return opts;
}

function runCliSubcommand(subcommand) {
  const result = spawnSync(process.execPath, [cliWrapperPath, subcommand], {
    env: process.env,
    stdio: "inherit",
  });
  return result.status ?? 1;
}

function runGlobalUpdate(manager, tag) {
  const spec = `${PACKAGE_NAME}@${normalizeTag(tag)}`;
  const argvByManager = {
    npm: ["npm", ["i", "-g", spec]],
    pnpm: ["pnpm", ["add", "-g", spec]],
    bun: ["bun", ["add", "-g", spec]],
  };

  const tuple = argvByManager[manager];
  if (!tuple) {
    throw new Error(`Unsupported package manager: ${manager}`);
  }

  const [bin, args] = tuple;

  // skip postinstall to prevent launching a new instance mid-update
  const result = spawnSync(bin, args, {
    env: { ...process.env, INFINITECONTEXT_SKIP_POSTINSTALL: "1" },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`Update failed while running: ${bin} ${args.join(" ")}`);
  }
}

// ── ANSI helpers ────────────────────────────────────────────────

const isTTY = process.stdout.isTTY;
const esc = (code) => (isTTY ? `\x1b[${code}m` : "");
const r = esc(0);
const b = esc(1);
const d = esc(2);
const blue = esc("38;2;47;111;179");
const green = esc("38;2;80;200;120");
const red = esc("38;2;220;80;80");
const cyan = esc("36");
const gray = esc("38;5;245");

async function runUpdate(rawArgs) {
  const opts = parseUpdateOptions(rawArgs);
  if (opts.help) {
    printUpdateHelp();
    return;
  }

  const manager = opts.manager ?? detectGlobalInstallManager();
  if (!manager) {
    throw new Error(
      "Could not detect install manager for this CLI. Re-run with --manager <npm|pnpm|bun>.",
    );
  }

  const previousVersion = readVersion();

  console.log("");
  console.log(`  ${blue}${b}InfiniteContext${r} ${d}Update${r}`);
  console.log("");

  // stop daemon before update
  const wasRunning = isDaemonRunning();
  if (wasRunning) {
    console.log(`  ${gray}○${r} ${d}Stopping daemon...${r}`);
    try {
      process.argv[2] = "stop";
      await runCtlSDK();
    } catch {
      console.log(`  ${gray}○${r} ${d}Could not stop daemon. Continuing update...${r}`);
    }
  }

  // run update
  console.log(`  ${gray}↓${r} ${d}Updating via ${manager}${r} ${gray}(${PACKAGE_NAME}@${opts.tag})${r}`);
  runGlobalUpdate(manager, opts.tag);

  // read new version after update
  const newVersion = readVersion();
  console.log("");
  console.log(`  ${green}✓${r} ${b}Updated${r}  ${gray}${previousVersion} → ${newVersion}${r}`);

  // auto-restart daemon in background (same terminal, no new window)
  if (wasRunning) {
    console.log(`  ${green}●${r} ${d}Restarting daemon...${r}`);
    try {
      // spawn daemon directly — detached + stdio to log file (no terminal allocation)
      const { spawn: spawnChild } = await import("node:child_process");
      const syncEntry = fileURLToPath(new URL("./sdk-sync.mjs", import.meta.url));
      const logDir = path.join(process.env.HOME || "~", ".infinitecontext");
      const { mkdirSync, openSync, closeSync } = await import("node:fs");
      mkdirSync(logDir, { recursive: true });
      const logFd = openSync(path.join(logDir, "daemon.log"), "a");
      const child = spawnChild(process.execPath, [syncEntry, "--daemon"], {
        detached: false,
        stdio: ["ignore", logFd, logFd],
        env: process.env,
      });
      child.unref();
      closeSync(logFd);
      await new Promise((r) => setTimeout(r, 500));
      console.log(`  ${green}●${r} ${d}Daemon running (PID ${child.pid}).${r}`);
    } catch {
      console.log(`  ${gray}○${r} ${d}Auto-restart failed. Run:${r} ${cyan}infinitecontext sync${r}`);
    }
  }

  console.log("");

  console.log("");
}

// ── update check ────────────────────────────────────────────────

const SKIP_UPDATE_CHECK = new Set(["version", "v", "update", "upgrade", "help", "h", "stop", "sync", ""]);

async function fetchLatestVersion() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch("https://registry.npmjs.org/infinitecontext/latest", { signal: controller.signal });
    const data = await res.json();
    return data.version ?? null;
  } catch { return null; }
  finally { clearTimeout(timeout); }
}

function isNewer(latest, current) {
  const l = latest.split(".").map(Number);
  const c = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

function printUpdateNotice(current, latest) {
  console.log(`\n  ${blue}${b}InfiniteContext${r} ${d}Update available${r}`);
  console.log(`  ${gray}${current}${r} → ${green}${b}${latest}${r}`);
  console.log(`  Run ${cyan}infinitecontext update${r} to upgrade.\n`);
}

// check on every invocation, no cache — like Claude Code
async function checkForUpdate() {
  const current = readVersion();
  if (current === "unknown") return;

  const latest = await fetchLatestVersion();
  if (latest && isNewer(latest, current)) {
    printUpdateNotice(current, latest);
  }
}

// ── launch helpers ──────────────────────────────────────────────

async function launchSyncDaemon() {
  const { launchDaemon } = await import("@infinitecontext/sync/launcher");
  await launchDaemon({
    entryPath: fileURLToPath(new URL("./sdk-sync.mjs", import.meta.url)),
    diagnosticsHint: "DAEMON_VERBOSE=1 infinitecontext sync",
  });
}

async function runCtlSDK() {
  const { runCtl } = await import("@infinitecontext/sync/ctl");
  await runCtl();
}

async function launchTui() {
  const { tuiBoot } = await import("@infinitecontext/sync/tui");
  await tuiBoot({
    assetsRoot: path.resolve(__dirname, "..", ".."),
  });
}

// ── main ────────────────────────────────────────────────────────

async function run() {
  // check for updates (silent on error, cached 24h)
  if (!SKIP_UPDATE_CHECK.has(command)) await checkForUpdate();

  // load saved key, then onboard if still missing
  let onboardResult = null;
  if (NEEDS_KEY.has(command)) {
    loadApiKeyFromConfig();
    if (!(await hasSyncCredentials())) onboardResult = await runOnboarding();
  }

  switch (command) {
    // sync: subcommand router
    case "sync":
    case "": {
      // sync start — daemon background only
      if (subcommand === "start") {
        await launchSyncDaemon();
        break;
      }

      // sync stop — stop daemon
      if (subcommand === "stop") {
        process.argv[2] = "stop";
        await runCtlSDK();
        break;
      }

      // sync status — show daemon status
      if (subcommand === "status") {
        process.argv[2] = "status";
        await runCtlSDK();
        break;
      }

      // bare sync (no subcommand) — daemon bg + TUI fg
      if (!isDaemonRunning()) await launchSyncDaemon();
      if (onboardResult?.launchTui !== false) await launchTui();
      break;
    }

    // legacy aliases — redirect to sync subcommands
    case "start":
      await launchSyncDaemon();
      break;

    case "stop":
      process.argv[2] = "stop";
      await runCtlSDK();
      break;

    case "config": {
      const configResult = await runOnboarding();
      if (configResult?.launchTui) {
        if (!isDaemonRunning()) await launchSyncDaemon();
        await launchTui();
      }
      break;
    }

    case "version":
    case "v":
      console.log(readVersion());
      break;

    case "update":
    case "upgrade":
      await runUpdate(process.argv.slice(3));
      break;

    case "switch": {
      const { runSwitch } = await import("./switch.mjs");
      await runSwitch();
      break;
    }

    case "login": {
      const { runLogin } = await import("./login.mjs");
      await runLogin();
      break;
    }

    case "logout": {
      const { runLogout } = await import("./login.mjs");
      await runLogout();
      break;
    }

    case "whoami": {
      const { runWhoami } = await import("./login.mjs");
      await runWhoami();
      break;
    }

    case "vault": {
      const { runVaultCli } = await import("./vault.mjs");
      await runVaultCli(process.argv.slice(3));
      break;
    }

    case "help":
    case "h":
      printHelp();
      break;

    default: {
      // migration hints for removed commands
      if (command === "tui") {
        console.log("The 'tui' command was removed. Use 'infinitecontext sync' instead (TUI is now built-in).");
        process.exit(0);
      }
      if (command === "status") {
        console.log("Use 'infinitecontext sync status' instead.");
        process.exit(0);
      }
      console.error(`Unknown command: ${process.argv[2]}`);
      printHelp();
      process.exit(1);
    }
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
