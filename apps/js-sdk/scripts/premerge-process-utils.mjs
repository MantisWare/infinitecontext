import fs from "node:fs";
import path from "node:path";

import { hasPremergeMutant } from "./premerge-mutant.mjs";

/** @param {number} pid */
export function listChildPids(pid) {
  /** @type {number[]} */
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (!/^\d+$/.test(ent)) {
      continue;
    }
    try {
      const stat = fs.readFileSync(`/proc/${ent}/stat`, "utf8");
      const match = /^\d+ \([^)]*\) \S (\d+) (\d+)/.exec(stat);
      if (!match) {
        continue;
      }
      const ppid = Number(match[1]);
      if (ppid === pid) {
        out.push(Number(ent));
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** @param {number} pgid @param {number} [excludePid] */
export function listProcessGroupPids(pgid, excludePid = process.pid) {
  /** @type {number[]} */
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (!/^\d+$/.test(ent)) {
      continue;
    }
    const pid = Number(ent);
    if (pid === excludePid) {
      continue;
    }
    try {
      const stat = fs.readFileSync(`/proc/${ent}/stat`, "utf8");
      const match = /^\d+ \([^)]*\) \S (\d+) (\d+)/.exec(stat);
      if (!match) {
        continue;
      }
      const pgrp = Number(match[2]);
      if (pgrp === pgid) {
        out.push(pid);
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

/**
 * @param {number} rootPid
 * @param {number} [excludePid]
 */
export function collectProcessTreePids(rootPid, excludePid = process.pid) {
  /** @type {number[]} */
  const out = [];
  /** @type {number[]} */
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined || seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    if (pid === excludePid) {
      continue;
    }
    try {
      process.kill(pid, 0);
      out.push(pid);
    } catch {
      continue;
    }
    for (const child of listChildPids(pid)) {
      stack.push(child);
    }
  }
  return out;
}

/**
 * @param {number} rootPid
 * @param {number} pgid
 * @param {number} [excludePid]
 */
export function collectLegProcessPids(rootPid, pgid, excludePid = process.pid) {
  const tree = collectProcessTreePids(rootPid, excludePid);
  const group = listProcessGroupPids(pgid, excludePid);
  return [...new Set([...tree, ...group])];
}

/**
 * @param {number[]} pids
 * @param {NodeJS.Signals} signal
 */
export function signalPids(pids, signal, kill = process.kill.bind(process)) {
  for (const pid of pids) {
    try {
      kill(pid, signal);
    } catch {
      /* already dead */
    }
  }
}

/**
 * @param {number} rootPid
 * @param {number} pgid
 * @param {number} timeoutMs
 * @param {number} [excludePid]
 */
export function waitForLegProcessesIdle(rootPid, pgid, timeoutMs, excludePid = process.pid) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      const alive = collectLegProcessPids(rootPid, pgid, excludePid);
      if (alive.length === 0 || Date.now() >= deadline) {
        resolve(alive.length === 0);
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

/**
 * @param {string} root
 * @param {NodeJS.Signals} [signal]
 */
export function killProcessesUsingPath(root, signal = "SIGKILL") {
  if (!root) {
    return;
  }
  const normalized = path.resolve(root);
  let entries;
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!/^\d+$/.test(ent)) {
      continue;
    }
    const pid = Number(ent);
    if (pid === process.pid) {
      continue;
    }
    /** @type {string[]} */
    const probes = [];
    try {
      probes.push(fs.readlinkSync(`/proc/${ent}/cwd`));
    } catch {
      /* ignore */
    }
    try {
      const raw = fs.readFileSync(`/proc/${ent}/environ`, "latin1");
      for (const part of raw.split("\0")) {
        if (part.startsWith("TMPDIR=") || part.startsWith("IC_PREMERGE_TMPDIR=")) {
          probes.push(part.slice(part.indexOf("=") + 1));
        }
      }
    } catch {
      /* ignore */
    }
    for (const probe of probes) {
      if (probe && path.resolve(probe).startsWith(normalized)) {
        try {
          process.kill(pid, signal);
        } catch {
          /* ignore */
        }
        break;
      }
    }
  }
}

/**
 * @param {string} root
 * @param {(dir: string) => void} [beforeRm]
 */
export function removePrivateTmpDirVerified(root, beforeRm) {
  if (!root) {
    return true;
  }
  beforeRm?.(root);
  if (!fs.existsSync(root)) {
    return true;
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!hasPremergeMutant("M6")) {
      killProcessesUsingPath(root, "SIGKILL");
    }
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* retry */
    }
    if (!fs.existsSync(root)) {
      return true;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  if (fs.existsSync(root)) {
    console.error(
      `ERROR: premerge failed to remove private TMPDIR after retry — leftover path: ${root}`,
    );
    return false;
  }
  return true;
}
