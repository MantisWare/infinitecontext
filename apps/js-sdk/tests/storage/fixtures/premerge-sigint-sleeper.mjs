import fs from "node:fs";

const readyPath = process.argv[2];
if (readyPath) {
  fs.writeFileSync(readyPath, "ready\n");
}

setInterval(() => {}, 60_000);
