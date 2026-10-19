import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = process.env.IC_PREMERGE_TMPDIR ?? process.env.TMPDIR ?? os.tmpdir();

spawn(
  process.execPath,
  [
    "-e",
    `const fs=require("fs");const d=${JSON.stringify(tmp)};setInterval(()=>{try{fs.mkdirSync(d,{recursive:true});fs.writeFileSync(d+"/ic-resume-late-"+Date.now()+".bin","x");}catch{}},25);`,
  ],
  { stdio: "ignore" },
);

setTimeout(() => {
  process.exit(0);
}, 120_000);
