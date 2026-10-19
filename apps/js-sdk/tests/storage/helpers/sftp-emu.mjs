import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SFTP_ATMOZ_DEFAULT_ROOT } from "../../../lib/storage/sftp-config.mjs";
import { sha256HostKeyFingerprint } from "../../../lib/storage/sftp-host-key.mjs";

const DEFAULT_IMAGE =
  "atmoz/sftp:alpine@sha256:7e439fabeae536fa254340724c042e11999924d906417dbb5c73602ad518813f";

/** @type {string[]} */
const DOCKER = fs.existsSync("/var/run/docker.sock") && process.getuid?.() !== 0 ? ["sudo", "docker"] : ["docker"];

/**
 * @returns {{
 *   host: string,
 *   port: number,
 *   username: string,
 *   root: string,
 *   privateKeyPath: string,
 *   hostKeySha256: string,
 *   containerName?: string,
 * } | null}
 */
export function resolveSftpEmuConfigFromEnv(env = process.env) {
  const require = String(env.IC_REQUIRE_SFTP ?? "").trim() === "1";
  const port = Number(env.IC_SFTP_TEST_PORT ?? 2222);
  const host = String(env.IC_SFTP_TEST_HOST ?? "127.0.0.1").trim();
  const username = String(env.IC_SFTP_TEST_USER ?? "ic").trim();
  const root = String(env.IC_SFTP_TEST_ROOT ?? SFTP_ATMOZ_DEFAULT_ROOT).trim();

  let containerName;
  if (!probeTcp(host, port)) {
    if (!require) {
      return null;
    }
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-sftp-fix-"));
    const priv = path.join(fixtureDir, "id_ed25519");
    execFileSync("ssh-keygen", ["-t", "ed25519", "-f", priv, "-N", "", "-C", "ic-sftp-emu-test"], {
      stdio: "ignore",
    });
    fs.chmodSync(priv, 0o600);
    const pub = `${priv}.pub`;
    containerName = `ic-sftp-emu-${crypto.randomBytes(4).toString("hex")}`;
    const run = spawnSync(
      DOCKER[0],
      [
        ...DOCKER.slice(1),
        "run",
        "-d",
        "--name",
        containerName,
        "-p",
        `127.0.0.1:${port}:22`,
        "-v",
        `${pub}:/home/ic/.ssh/keys/id_ed25519.pub:ro`,
        DEFAULT_IMAGE,
        `${username}::1001:100:${root}`,
      ],
      { encoding: "utf8" },
    );
    if (run.status !== 0) {
      throw new Error(`IC_REQUIRE_SFTP=1 but failed to start SFTP container: ${run.stderr || run.stdout}`);
    }
    waitForPort(host, port, 60_000);
    execFileSync("sleep", ["2"]);
    const hostKeySha256 = String(env.IC_SFTP_TEST_HOST_KEY_SHA256 ?? "").trim();
    const pinned = hostKeySha256 || sha256HostKeyFingerprint(scanHostKey(host, port));
    return {
      host,
      port,
      username,
      root,
      privateKeyPath: priv,
      hostKeySha256: pinned,
      containerName,
    };
  }

  const privateKeyPath = String(env.IC_SFTP_TEST_PRIVATE_KEY_PATH ?? "").trim();
  let hostKeySha256 = String(env.IC_SFTP_TEST_HOST_KEY_SHA256 ?? "").trim();
  if (!privateKeyPath) {
    if (require) {
      throw new Error(
        "IC_REQUIRE_SFTP=1 and SFTP port is open: set IC_SFTP_TEST_PRIVATE_KEY_PATH (Fix PR emu-up generates keys)",
      );
    }
    return null;
  }
  if (!hostKeySha256) {
    hostKeySha256 = sha256HostKeyFingerprint(scanHostKey(host, port));
  }
  return { host, port, username, root, privateKeyPath, hostKeySha256 };
}

/** @param {string} containerName */
export function stopSftpEmuContainer(containerName) {
  if (!containerName) return;
  spawnSync(DOCKER[0], [...DOCKER.slice(1), "rm", "-f", containerName], { stdio: "ignore" });
}

/** @param {NonNullable<ReturnType<typeof resolveSftpEmuConfigFromEnv>>} cfg */
export function sftpTestConfig(cfg) {
  return {
    storage: {
      backend: "sftp",
      sftp: {
        host: cfg.host,
        port: cfg.port,
        username: cfg.username,
        root: cfg.root,
        privateKeyPath: cfg.privateKeyPath,
        hostKeySha256: cfg.hostKeySha256,
      },
    },
  };
}

/** @param {string} host @param {number} port */
function probeTcp(host, port) {
  try {
    execFileSync("bash", ["-lc", `timeout 1 bash -c '</dev/tcp/${host}/${port}'`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** @param {string} host @param {number} port @param {number} timeoutMs */
function waitForPort(host, port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (probeTcp(host, port)) {
      return;
    }
    execFileSync("sleep", ["0.2"]);
  }
  throw new Error(`Timed out waiting for ${host}:${port}`);
}

/** @param {string} containerName */
function fetchContainerHostKey(containerName) {
  const out = execFileSync(DOCKER[0], [...DOCKER.slice(1), "exec", containerName, "cat", "/etc/ssh/ssh_host_ed25519_key.pub"], {
    encoding: "utf8",
  });
  const parts = out.trim().split(/\s+/);
  return Buffer.from(parts[1], "base64");
}

/** @param {string} host @param {number} port */
function scanHostKey(host, port) {
  const out = execFileSync("ssh-keyscan", ["-p", String(port), "-t", "ed25519", host], { encoding: "utf8" });
  const line = out.split("\n").find((row) => row.trim() && !row.startsWith("#"));
  if (!line) {
    throw new Error(`ssh-keyscan returned no key for ${host}:${port}`);
  }
  const parts = line.trim().split(/\s+/);
  return Buffer.from(parts[2], "base64");
}
