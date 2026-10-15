import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "ic-storage-test-home-"));
process.env.HOME = isolatedHome;
