import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as acorn from "acorn";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const libRoot = path.join(sdkRoot, "lib");

if (process.env.ALLOW_LIB_TEST_ENV === "1") {
  console.log("check-lib-no-test-env: ALLOW_LIB_TEST_ENV=1 — skipping lib/ TEST env guard");
  process.exit(0);
}

/** @param {string} name */
function isForbiddenTestEnvKey(name) {
  if (typeof name !== "string" || !name) {
    return false;
  }
  if (name === "IC_TESTING") {
    return true;
  }
  if (/^IC_TEST[A-Z0-9_]*$/i.test(name)) {
    return true;
  }
  if (!/(?:^|_)TEST(?:_|$)/i.test(name) && !/^TEST_/i.test(name)) {
    return false;
  }
  if (/LATEST_VERSION|MY_TESTER|CONTEST|ATTEST|DETEST|PROTEST/i.test(name)) {
    return false;
  }
  return true;
}

/** @param {import('acorn').Node | null | undefined} node */
function literalKey(node) {
  if (!node) {
    return null;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "Identifier") {
    return node.name;
  }
  return null;
}

/**
 * @param {string} file
 * @param {string} src
 * @returns {string[]}
 */
function findViolations(file, src) {
  /** @type {string[]} */
  const hits = [];
  /** @type {Map<string, string>} */
  const envBindings = new Map();

  let program;
  try {
    program = acorn.parse(src, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
    });
  } catch (err) {
    hits.push(`${file}: parse error ${err instanceof Error ? err.message : String(err)}`);
    return hits;
  }

  /** @param {import('acorn').Node} node */
  function noteImport(node) {
    if (node.type !== "ImportDeclaration") {
      return;
    }
    const from = node.source.value;
    if (from !== "node:process" && from !== "process") {
      return;
    }
    for (const spec of node.specifiers) {
      if (spec.type === "ImportDefaultSpecifier") {
        envBindings.set(spec.local.name, "processModule");
      } else if (spec.type === "ImportNamespaceSpecifier") {
        envBindings.set(spec.local.name, "processModule");
      } else if (spec.type === "ImportSpecifier") {
        if (spec.imported.name === "env") {
          envBindings.set(spec.local.name, "env");
        }
      }
    }
  }

  /** @param {import('acorn').Node} node */
  function noteTopLevel(node) {
    if (node.type === "VariableDeclaration") {
      for (const decl of node.declarations) {
        if (decl.init?.type === "Identifier" && decl.init.name === "process") {
          for (const id of [decl.id].flat()) {
            if (id.type === "Identifier") {
              envBindings.set(id.name, "processAlias");
            }
            if (id.type === "ObjectPattern") {
              for (const prop of id.properties) {
                if (prop.type === "Property") {
                  const key = literalKey(prop.key);
                  if (key === "env") {
                    const local = prop.value.type === "Identifier" ? prop.value.name : null;
                    if (local) {
                      envBindings.set(local, "env");
                    }
                  }
                }
              }
            }
          }
        }
        if (decl.init?.type === "MemberExpression") {
          const mem = decl.init;
          if (
            mem.object.type === "Identifier" &&
            mem.object.name === "globalThis" &&
            mem.property.type === "Identifier" &&
            mem.property.name === "process"
          ) {
            if (decl.id.type === "Identifier") {
              envBindings.set(decl.id.name, "processAlias");
            }
          }
        }
      }
    }
  }

  /** @param {import('acorn').MemberExpression} node @param {number} line */
  function checkMember(node, line) {
    const key = literalKey(node.property);
    if (node.object.type === "MemberExpression") {
      const inner = node.object;
      if (
        inner.object.type === "Identifier" &&
        inner.object.name === "process" &&
        inner.property.type === "Identifier" &&
        inner.property.name === "env" &&
        key &&
        isForbiddenTestEnvKey(key)
      ) {
        hits.push(`${file}:${line}: process.env.${key}`);
        return;
      }
    }
    if (node.object.type === "Identifier") {
      const binding = envBindings.get(node.object.name);
      if (binding === "env" && key && isForbiddenTestEnvKey(key)) {
        hits.push(`${file}:${line}: ${node.object.name}.${key}`);
        return;
      }
      if (binding === "processModule" || binding === "processAlias") {
        if (node.property.type === "Identifier" && node.property.name === "env") {
          const innerKey = node.parent?.type === "MemberExpression" ? literalKey(node.parent.property) : null;
          if (innerKey && isForbiddenTestEnvKey(innerKey)) {
            hits.push(`${file}:${line}: ${node.object.name}.env.${innerKey}`);
          }
        }
      }
    }
    if (
      node.object.type === "MemberExpression" &&
      node.object.object.type === "Identifier" &&
      envBindings.get(node.object.object.name) === "processModule" &&
      node.object.property.type === "Identifier" &&
      node.object.property.name === "env"
    ) {
      hits.push(`${file}:${line}: imported process env.${key}`);
    }
  }

  /** @param {import('acorn').Node} node */
  function walk(node, parent = null) {
    if (!node || typeof node !== "object") {
      return;
    }
    node.parent = parent;
    if (node.type === "ImportDeclaration") {
      noteImport(node);
    }
    if (node.type === "VariableDeclaration" && (!parent || parent.type === "Program")) {
      noteTopLevel(node);
    }
    if (node.type === "MemberExpression" && !node.computed) {
      checkMember(node, node.loc?.start.line ?? 0);
    }
    if (node.type === "MemberExpression" && node.computed && node.property.type === "Literal") {
      checkMember(node, node.loc?.start.line ?? 0);
    }
    if (node.type === "CallExpression") {
      if (
        node.callee.type === "MemberExpression" &&
        node.callee.object.type === "Identifier" &&
        node.callee.object.name === "Reflect" &&
        node.callee.property.type === "Identifier" &&
        node.callee.property.name === "get" &&
        node.arguments.length >= 2
      ) {
        const obj = node.arguments[0];
        const prop = node.arguments[1];
        if (
          obj.type === "MemberExpression" &&
          obj.object.type === "Identifier" &&
          obj.object.name === "process" &&
          obj.property.type === "Identifier" &&
          obj.property.name === "env"
        ) {
          const key = literalKey(prop);
          if (key && isForbiddenTestEnvKey(key)) {
            hits.push(`${file}:${node.loc?.start.line ?? 0}: Reflect.get(process.env, ${key})`);
          }
        }
      }
      if (
        node.callee.type === "MemberExpression" &&
        node.callee.property.type === "Identifier" &&
        node.callee.property.name === "entries" &&
        node.arguments[0]?.type === "MemberExpression"
      ) {
        const arg = node.arguments[0];
        if (
          arg.object.type === "Identifier" &&
          arg.object.name === "process" &&
          arg.property.type === "Identifier" &&
          arg.property.name === "env"
        ) {
          hits.push(`${file}:${node.loc?.start.line ?? 0}: Object.entries(process.env) scan`);
        }
      }
    }
    for (const key of Object.keys(node)) {
      if (key === "parent") {
        continue;
      }
      const child = node[key];
      if (Array.isArray(child)) {
        for (const c of child) {
          if (c && typeof c.type === "string") {
            walk(c, node);
          }
        }
      } else if (child && typeof child.type === "string") {
        walk(child, node);
      }
    }
  }

  walk(program);
  return hits;
}

/** @param {string} dir @param {string[]} out */
function walkLib(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      walkLib(full, out);
      continue;
    }
    if (!name.endsWith(".mjs") && !name.endsWith(".js")) {
      continue;
    }
    out.push(full);
  }
}

/** @type {string[]} */
const files = [];
walkLib(libRoot, files);

/** @type {string[]} */
const allHits = [];
for (const file of files) {
  const rel = path.relative(sdkRoot, file);
  const src = fs.readFileSync(file, "utf8");
  allHits.push(...findViolations(rel, src));
}

const unique = [...new Set(allHits)];
if (unique.length > 0) {
  console.error("check-lib-no-test-env: lib/ must not read process.env.*TEST (use *ForTests setters in tests):\n");
  console.error(unique.join("\n"));
  process.exit(1);
}

console.log("check-lib-no-test-env: ok");
