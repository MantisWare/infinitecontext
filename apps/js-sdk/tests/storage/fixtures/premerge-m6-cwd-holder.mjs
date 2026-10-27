import process from "node:process";

const dir = process.argv[2];
if (!dir) {
  process.exit(1);
}
process.chdir(dir);
setInterval(() => {}, 60_000);
