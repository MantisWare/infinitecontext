import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

const tmp = process.env.IC_PREMERGE_TMPDIR ?? process.env.TMPDIR ?? os.tmpdir();
fs.mkdirSync(tmp, { recursive: true });
const holdPath = `${tmp}/ic-orphan-fd-hold.bin`;
const pidPath =
  String(process.env.IC_PREMERGE_ORPHAN_PID_FILE ?? "").trim() ||
  `${os.tmpdir()}/ic-m1b-orphan-fd-${process.ppid}.pid`;
fs.writeFileSync(holdPath, "hold");

const orphan = spawn(
  process.execPath,
  [
    "-e",
    `const fs=require("fs");const p=${JSON.stringify(holdPath)};fs.openSync(p,"r");setTimeout(()=>process.exit(0),15000);setInterval(()=>{},60000);`,
  ],
  {
    cwd: "/",
    env: { PATH: process.env.PATH ?? "" },
    detached: true,
    stdio: "ignore",
  },
);
fs.writeFileSync(pidPath, String(orphan.pid));
console.log(`ORPHAN_PID=${orphan.pid}`);
orphan.unref();

setTimeout(() => process.exit(0), 120_000);
