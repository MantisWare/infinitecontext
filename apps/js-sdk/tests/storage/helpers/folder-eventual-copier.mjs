import fs from "node:fs";
import path from "node:path";

const OBJECTS = "objects";

/**
 * Best-effort mirror of ciphertext object trees between two folder adapter roots.
 */
export class SimulatedEventualCopier {
  /**
   * @param {string} dirA
   * @param {string} dirB
   */
  constructor(dirA, dirB) {
    this.dirA = path.resolve(dirA);
    this.dirB = path.resolve(dirB);
  }

  /**
   * @param {"AtoB" | "BtoA"} direction
   * @param {{ delayMs?: number, shuffle?: boolean, conflictRename?: (name: string) => string }} [opts]
   */
  async sync(direction, opts = {}) {
    const fromRoot = direction === "AtoB" ? this.dirA : this.dirB;
    const toRoot = direction === "AtoB" ? this.dirB : this.dirA;
    const fromObjects = path.join(fromRoot, OBJECTS);
    if (!fs.existsSync(fromObjects)) return;
    /** @type {string[]} */
    const files = [];
    const walk = (cursor, rel) => {
      for (const name of fs.readdirSync(cursor)) {
        const abs = path.join(cursor, name);
        const st = fs.lstatSync(abs);
        const relPath = rel ? `${rel}/${name}` : name;
        if (st.isDirectory()) {
          walk(abs, relPath);
        } else if (st.isFile()) {
          files.push(relPath);
        }
      }
    };
    walk(fromObjects, "");
    if (opts.shuffle) {
      for (let i = files.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [files[i], files[j]] = [files[j], files[i]];
      }
    }
    for (const rel of files) {
      if (opts.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
      }
      const src = path.join(fromObjects, rel);
      let destName = path.basename(rel);
      if (opts.conflictRename) {
        const renamed = opts.conflictRename(destName);
        if (renamed !== destName) {
          destName = renamed;
        }
      }
      const destRel = path.join(path.dirname(rel), destName);
      const dest = path.join(toRoot, OBJECTS, destRel);
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.copyFileSync(src, dest);
      try {
        fs.chmodSync(dest, 0o600);
      } catch {
        /* ignore */
      }
    }
  }
}
