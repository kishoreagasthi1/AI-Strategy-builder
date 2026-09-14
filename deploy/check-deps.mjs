/**
 * Are the declared dependencies actually installed? (v5.34.71)
 *
 * ── Why this runs before `tsc -p tsconfig.test.json` ────────────────────────
 *
 * v5.34.69 added the test suite to the typecheck gate, which was right — ~140
 * test files had never been typechecked by anything. But a typechecker on an
 * incomplete node_modules does not report "a package is missing". It reports
 * the CONSEQUENCES, and they are loud out of all proportion to the cause.
 *
 * Observed on the deploy Mac, 2026-09-13, on a checkout that had not run
 * `npm install` since playwright-core became a devDependency:
 *
 *     Found 82 errors in 8 files.
 *
 * Eighty-one of those were TS7006 "implicitly has an 'any' type" and TS18046
 * "is of type 'unknown'", spread across six browser test files, each one
 * pointing at an innocent `(tds) => ...` callback. Exactly ONE was the truth:
 *
 *     harness.ts:46 - error TS2307: Cannot find module 'playwright-core'
 *
 * It sat 65 lines into the output. With that import unresolved `Page` is an
 * error type, `h.page` degrades to any, every `$$eval` callback parameter
 * loses its contextual type, and noImplicitAny fires on all of them. The gate
 * announces itself as "what catches source/test drift before it ships", so the
 * reader's first move is to go hunting for drift in tests that are fine.
 *
 * v5.34.58 already hit the runtime half of this and fixed it by importing
 * playwright-core lazily, so a missing package could not break test
 * COLLECTION. The type-only import still resolves at compile time, so .69
 * reintroduced the same fragility one layer up. This closes it at the cause
 * instead: name the missing package, before anything downstream can editorialise.
 *
 * Deliberately NOT solved by excluding test/browser from the typecheck. Those
 * files are the only thing standing between a renamed element id and a billing
 * screen that silently renders nothing; blinding the gate to them to quieten a
 * missing-install message would trade a real check for a cosmetic one.
 *
 * Usage — from backend/, which is the node_modules this checks:
 *   cd backend && node ../deploy/check-deps.mjs
 *
 * Exit 0 = everything declared is resolvable. Exit 1 = names what is missing.
 */
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const pkgPath = join(root, "package.json");

if (!existsSync(pkgPath)) {
  console.error(`No package.json in ${root}.`);
  console.error("Run this from the backend directory:  cd backend && node ../deploy/check-deps.mjs");
  process.exit(1);
}

if (!existsSync(join(root, "node_modules"))) {
  console.error("node_modules is missing entirely.");
  console.error("  cd backend && npm install");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

/*
 * require.resolve on the package's own package.json rather than on the package
 * name. A package name only resolves if it has a main/exports entry a CJS
 * resolver will accept, which is not true of every type-only or ESM-only
 * package — `@types/*` have no entry point at all. package.json always exists
 * and every modern package exports it.
 */
const requireFrom = createRequire(join(root, "noop.js"));
const missing = [];
for (const name of Object.keys(declared)) {
  try {
    requireFrom.resolve(`${name}/package.json`);
  } catch {
    // Fall back to a plain directory check: a handful of older packages
    // restrict `exports` and refuse the subpath above even when installed.
    if (!existsSync(join(root, "node_modules", ...name.split("/")))) {
      missing.push(`${name}@${declared[name]}`);
    }
  }
}

if (!missing.length) {
  console.log(`>> Dependencies present (${Object.keys(declared).length} declared).`);
  process.exit(0);
}

console.error("");
console.error(`${missing.length} declared package(s) are NOT installed:`);
for (const m of missing) console.error(`  ${m}`);
console.error("");
console.error("Fix this before reading any typecheck output — a missing package");
console.error("surfaces as dozens of unrelated 'implicitly has an any type' errors");
console.error("in files that are perfectly fine:");
console.error("");
console.error("  cd backend && npm install");
console.error("");
process.exit(1);
