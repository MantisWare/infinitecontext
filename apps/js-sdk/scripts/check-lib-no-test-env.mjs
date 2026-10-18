import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as acorn from "acorn";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const libRoot = path.join(sdkRoot, "lib");

if (process.env.ALLOW_LIB_TEST_ENV === "1") {
  console.error(
    "WARNING: check-lib-no-test-env: ALLOW_LIB_TEST_ENV=1 — skipping lib/ TEST env guard (Dev Lead override only; do not use in premerge/CI)",
  );
  process.exit(0);
}

/** @param {string} name */
export function isForbiddenTestEnvKey(name) {
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
function literalString(node) {
  if (!node) {
    return null;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0 && node.quasis.length === 1) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

/** @param {import('acorn').Node | null | undefined} node */
function concatStringLiteral(node) {
  const lit = literalString(node);
  if (lit !== null) {
    return lit;
  }
  if (node?.type === "BinaryExpression" && node.operator === "+") {
    const left = concatStringLiteral(node.left);
    const right = concatStringLiteral(node.right);
    if (left !== null && right !== null) {
      return left + right;
    }
  }
  return null;
}

/**
 * @param {string} file
 * @param {string} src
 * @returns {string[]}
 */
export function findViolations(file, src) {
  /** @type {string[]} */
  const hits = [];
  /** @type {Map<string, "env" | "processEnv" | "processModule" | "processAlias" | "globalThisAlias">} */
  const bindings = new Map();
  /** @type {Map<string, string>} */
  const stringConstBindings = new Map();

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

  /** @param {number} line */
  function hit(line, msg) {
    hits.push(`${file}:${line}: ${msg}`);
  }

  /** @param {import('acorn').Node | null | undefined} node */
  function isProcessIdentifier(node) {
    return node?.type === "Identifier" && node.name === "process";
  }

  /** @param {import('acorn').Node | null | undefined} node */
  function isGlobalThis(node) {
    return node?.type === "Identifier" && node.name === "globalThis";
  }

  /** @param {import('acorn').MemberExpression} node */
  function memberPropName(node) {
    if (node.computed) {
      return null;
    }
    if (node.property.type === "Identifier") {
      return node.property.name;
    }
    return null;
  }

  /** @param {import('acorn').Node | null | undefined} node */
  function isEnvMember(node) {
    if (!node || node.type !== "MemberExpression" || !node.property) {
      return false;
    }
    const envKey =
      (!node.computed && node.property.type === "Identifier" && node.property.name === "env") ||
      (node.computed && literalString(node.property) === "env");
    if (!envKey) {
      return false;
    }
    const base = node.object;
    if (isProcessIdentifier(base)) {
      return true;
    }
    if (base.type === "CallExpression" && isProcessRequireOrImport(base)) {
      return true;
    }
    if (base.type === "AwaitExpression" && isProcessDynamicImport(base.argument)) {
      return true;
    }
    if (base.type === "Identifier") {
      const b = bindings.get(base.name);
      if (b === "env" || b === "processAlias") {
        return true;
      }
      if (b === "processModule" && envKey) {
        return true;
      }
    }
    if (base.type === "MemberExpression" && memberPropName(base) === "process") {
      if (isGlobalThis(base.object)) {
        return true;
      }
      if (base.object.type === "Identifier" && bindings.get(base.object.name)) {
        return true;
      }
    }
    return false;
  }

  /** @param {import('acorn').Node | null | undefined} node @returns {"env" | null} */
  function resolveProcessEnvRef(node) {
    if (!node) {
      return null;
    }
    if (node.type === "MemberExpression" && isEnvMember(node)) {
      return "env";
    }
    if (node.type === "Identifier" && bindings.get(node.name) === "env") {
      return "env";
    }
    return null;
  }

  /** @param {import('acorn').Node} node */
  function isProcessRequireOrImport(node) {
    if (node.type === "ImportExpression") {
      const src = node.source;
      return (
        src?.type === "Literal" &&
        (src.value === "process" || src.value === "node:process")
      );
    }
    if (node.type !== "CallExpression") {
      return false;
    }
    if (
      node.callee.type === "Identifier" &&
      node.callee.name === "require" &&
      node.arguments[0]?.type === "Literal" &&
      (node.arguments[0].value === "process" || node.arguments[0].value === "node:process")
    ) {
      return true;
    }
    if (
      node.callee.type === "Import" &&
      node.arguments[0]?.type === "Literal" &&
      (node.arguments[0].value === "process" || node.arguments[0].value === "node:process")
    ) {
      return true;
    }
    return false;
  }

  /** @param {import('acorn').Node | null | undefined} node */
  function isProcessDynamicImport(node) {
    return isProcessRequireOrImport(node);
  }

  /** @param {import('acorn').Node} node */
  function noteBindings(node) {
    if (node.type === "ImportDeclaration") {
      const from = node.source.value;
      if (from !== "node:process" && from !== "process") {
        return;
      }
      for (const spec of node.specifiers) {
        if (spec.type === "ImportDefaultSpecifier" || spec.type === "ImportNamespaceSpecifier") {
          bindings.set(spec.local.name, "processModule");
        } else if (spec.type === "ImportSpecifier" && spec.imported.name === "env") {
          bindings.set(spec.local.name, "env");
        }
      }
    }
    if (node.type === "VariableDeclarator" && node.init) {
      if (node.id.type === "Identifier") {
        const folded = concatStringLiteral(node.init);
        if (folded !== null) {
          stringConstBindings.set(node.id.name, folded);
        }
      }
      const envRef = resolveProcessEnvRef(node.init);
      if (envRef === "env" && node.id.type === "Identifier") {
        bindings.set(node.id.name, "env");
      }
      if (node.init.type === "MemberExpression" && memberPropName(node.init) === "process") {
        if (isGlobalThis(node.init.object) && node.id.type === "Identifier") {
          bindings.set(node.id.name, "processAlias");
        }
      }
      if (node.id.type === "ObjectPattern" && resolveProcessEnvRef(node.init) === "env") {
        hit(node.loc?.start.line ?? 0, "destructuring from process.env");
      }
      if (
        node.id.type === "ObjectPattern" &&
        node.init?.type === "Identifier" &&
        node.init.name === "process"
      ) {
        for (const prop of node.id.properties) {
          if (prop.type === "Property") {
            const key = literalString(prop.key) ?? (prop.key.type === "Identifier" ? prop.key.name : null);
            if (key === "env" && prop.value.type === "Identifier") {
              bindings.set(prop.value.name, "env");
            }
          }
        }
      }
      if (
        node.id.type === "ObjectPattern" &&
        node.init?.type === "MemberExpression" &&
        memberPropName(node.init) === "process" &&
        isGlobalThis(node.init.object)
      ) {
        for (const prop of node.id.properties) {
          if (prop.type === "Property") {
            const key = literalString(prop.key) ?? (prop.key.type === "Identifier" ? prop.key.name : null);
            if (key === "env" && prop.value.type === "Identifier") {
              bindings.set(prop.value.name, "env");
            }
          }
        }
      }
      if (node.init.type === "MemberExpression" && memberPropName(node.init) === "env") {
        const obj = node.init.object;
        if (obj.type === "MemberExpression" && memberPropName(obj) === "process" && isGlobalThis(obj.object)) {
          if (node.id.type === "ObjectPattern") {
            hit(node.loc?.start.line ?? 0, "destructuring from globalThis.process.env");
          }
          if (node.id.type === "Identifier") {
            bindings.set(node.id.name, "env");
          }
        }
      }
      if (isProcessRequireOrImport(node.init) && node.id.type === "Identifier") {
        bindings.set(node.id.name, "processModule");
      }
      if (node.init.type === "AwaitExpression" && isProcessDynamicImport(node.init.argument)) {
        if (node.id.type === "Identifier") {
          bindings.set(node.id.name, "processModule");
        }
      }
      if (
        node.init.type === "MemberExpression" &&
        memberPropName(node.init) === "env" &&
        node.init.object.type === "AwaitExpression"
      ) {
        if (node.id.type === "Identifier") {
          bindings.set(node.id.name, "env");
        }
      }
      if (node.init.type === "Identifier" && bindings.get(node.init.name) === "processAlias") {
        if (node.id.type === "Identifier") {
          bindings.set(node.id.name, "processAlias");
        }
      }
      if (
        node.init.type === "MemberExpression" &&
        memberPropName(node.init) === "process" &&
        node.init.object.type === "Identifier" &&
        (bindings.get(node.init.object.name) === "globalThisAlias" ||
          bindings.get(node.init.object.name) === "processAlias")
      ) {
        if (node.id.type === "Identifier") {
          bindings.set(node.id.name, "processAlias");
        }
      }
      if (node.init.type === "Identifier" && node.init.name === "globalThis" && node.id.type === "Identifier") {
        bindings.set(node.id.name, "globalThisAlias");
      }
      if (
        node.init.type === "MemberExpression" &&
        memberPropName(node.init) === "env" &&
        isEnvMember(node.init) &&
        node.id.type === "Identifier"
      ) {
        bindings.set(node.id.name, "env");
      }
    }
  }

  /** @param {import('acorn').MemberExpression} node */
  function checkEnvMemberAccess(node) {
    if (!node?.property) {
      return;
    }
    const line = node.loc?.start.line ?? 0;
    const onEnv =
      isEnvMember(node.object) ||
      resolveProcessEnvRef(node.object) === "env" ||
      (node.object?.type === "Identifier" && bindings.get(node.object.name) === "env");
    if (!onEnv) {
      return;
    }

    if (
      node.computed &&
      node.property.type === "MemberExpression" &&
      node.property.object.type === "Identifier" &&
      node.property.object.name === "keyDef" &&
      node.property.property.type === "Identifier" &&
      node.property.property.name === "env"
    ) {
      return;
    }
    if (node.computed) {
      const keyLit = concatStringLiteral(node.property);
      if (keyLit !== null) {
        if (isForbiddenTestEnvKey(keyLit)) {
          hit(line, `process.env[${JSON.stringify(keyLit)}]`);
        }
        return;
      }
      if (node.property.type === "Identifier") {
        const bound = stringConstBindings.get(node.property.name);
        if (bound !== undefined) {
          if (isForbiddenTestEnvKey(bound)) {
            hit(line, `process.env[${node.property.name} → ${JSON.stringify(bound)}]`);
          }
          return;
        }
      }
      hit(line, "process.env[non-literal key]");
      return;
    }
    if (!node.computed && node.property.type === "Identifier") {
      if (node.property.name === "env") {
        return;
      }
      if (isForbiddenTestEnvKey(node.property.name)) {
        hit(line, `process.env.${node.property.name}`);
      }
      return;
    }
    if (node.property.type === "Literal") {
      const key = String(node.property.value);
      if (isForbiddenTestEnvKey(key)) {
        hit(line, `process.env.${key}`);
      }
      return;
    }
    if (node.property.type === "TemplateLiteral") {
      hit(line, "process.env[template-literal key]");
      return;
    }
    hit(line, "process.env[non-literal key]");
  }

  /** @param {import('acorn').CallExpression} node */
  function checkCall(node) {
    const line = node.loc?.start.line ?? 0;
    const callee = node.callee;
    if (callee.type === "MemberExpression" && callee.property.type === "Identifier") {
      const method = callee.property.name;
      if (["keys", "values", "entries", "getOwnPropertyNames"].includes(method)) {
        if (node.arguments[0] && resolveProcessEnvRef(node.arguments[0]) === "env") {
          hit(line, `Object.${method}(process.env) whole-env enumeration`);
        }
      }
    }
    if (
      callee.type === "MemberExpression" &&
      callee.object.type === "Identifier" &&
      callee.object.name === "Reflect" &&
      callee.property.type === "Identifier" &&
      callee.property.name === "get" &&
      node.arguments.length >= 2
    ) {
      const envArg = node.arguments[0];
      if (resolveProcessEnvRef(envArg) === "env") {
        const keyLit = concatStringLiteral(node.arguments[1]);
        if (keyLit !== null && isForbiddenTestEnvKey(keyLit)) {
          hit(line, `Reflect.get(process.env, ${JSON.stringify(keyLit)})`);
        } else if (keyLit === null) {
          hit(line, "Reflect.get(process.env, non-literal key)");
        }
      }
    }
    if (isProcessRequireOrImport(node) && node.parent?.type === "MemberExpression") {
      return;
    }
  }

  /** @param {import('acorn').Node} node */
  function walkCollectBindings(node) {
    if (!node || typeof node !== "object") {
      return;
    }
    noteBindings(node);
    for (const key of Object.keys(node)) {
      if (key === "parent") {
        continue;
      }
      const child = node[key];
      if (Array.isArray(child)) {
        for (const c of child) {
          if (c && typeof c.type === "string") {
            walkCollectBindings(c);
          }
        }
      } else if (child && typeof child.type === "string") {
        walkCollectBindings(child);
      }
    }
  }

  /** @param {import('acorn').Node} node */
  function walkAudit(node) {
    if (!node || typeof node !== "object") {
      return;
    }
    if (node.type === "MemberExpression") {
      checkEnvMemberAccess(node);
    }
    if (node.type === "CallExpression") {
      checkCall(node);
    }
    for (const key of Object.keys(node)) {
      if (key === "parent") {
        continue;
      }
      const child = node[key];
      if (Array.isArray(child)) {
        for (const c of child) {
          if (c && typeof c.type === "string") {
            walkAudit(c);
          }
        }
      } else if (child && typeof child.type === "string") {
        walkAudit(child);
      }
    }
  }

  walkCollectBindings(program);
  walkAudit(program);
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

function runLibScan() {
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
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun && process.env.ALLOW_LIB_TEST_ENV !== "1") {
  runLibScan();
}
