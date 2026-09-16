/**
 * tools/tests/archmap-analysis.test.mjs
 * Behavioral tests for AST & call graph analysis:
 * - Symbol identification: nested, arrow, function, class, method, constructor, module
 * - Same-line symbols disambiguation with unique start offset
 * - Static call graph: function-to-function, cross-file import/export, arrow assigned to const
 * - Constructor calls via `new Class()` pointing to constructor
 * - Unresolved calls: external, dynamic, unresolved
 * - Ignoring comments and string literals (avoiding false positives)
 * - Diagnostics on syntax errors
 * - Compiler-resolved fileDeps: tsconfig paths/baseUrl, re-export chain, side-effect import, .mts, external exclusion
 * - Scanner merges resolved deps into the module graph
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { analyzeProjectJsTs } from "../archmap-analysis.mjs";

test("analyzeProjectJsTs: symbols, calls, new Class constructor, arrow const, same-line disambiguation, false-positive protection", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "archmap-test-"));

  try {
    // File A: exports arrow function and class with constructor and method
    const fileA = `
// Comment containing fake call: runFake() "and string fake() in comment"
export const helperArrow = (x) => {
  const fakeInString = "fakeCallInsideString()";
  return x + 1;
};

export class ServiceWorker {
  constructor(name) {
    this.name = name;
  }

  process() {
    return helperArrow(42);
  }
}

// Multiple anonymous arrows on the exact same line with callers
export const getHandlers = () => [((x) => x + 1), ((x) => x + 2)];
`;

    // File B: imports from A, instantiates with new, calls arrow, has unresolved & dynamic calls
    const fileB = `
import { helperArrow, ServiceWorker, fnOne } from "./fileA.js";

export function entrypoint() {
  const worker = new ServiceWorker("main");
  worker.process();
  const direct = helperArrow(10);
  const handlers = getHandlers();
  handlers[0](10);

  // Dynamic call
  const obj = {};
  obj["dynamicMethod"]();

  // External call
  console.log("hello");

  // Unresolved call
  unresolvedFunctionCall();
}

// Syntax error file for diagnostics test
`;

    const fileSyntaxErr = `
export function broken( {
  return ;
`;

    writeFileSync(join(testDir, "fileA.js"), fileA, "utf8");
    writeFileSync(join(testDir, "fileB.js"), fileB, "utf8");
    writeFileSync(join(testDir, "syntaxErr.js"), fileSyntaxErr, "utf8");

    const result = await analyzeProjectJsTs(testDir, ["fileA.js", "fileB.js", "syntaxErr.js"]);

    assert.ok(result, "Result should exist");
    assert.ok(Array.isArray(result.symbols), "symbols should be an array");
    assert.ok(Array.isArray(result.calls), "calls should be an array");
    assert.ok(Array.isArray(result.unresolvedCalls), "unresolvedCalls should be an array");
    assert.ok(result.analysis, "analysis metadata should exist");
    const fileASyms = result.symbols.filter(s => s.file === "fileA.js");
    const arrowSyms = fileASyms.filter((s) => s.kind === "arrow" && s.name === "anonymous");
    assert.equal(arrowSyms.length, 2, `Both same-line anonymous arrow functions must be recorded as symbols. Found: ${JSON.stringify(fileASyms)}`);
    assert.notEqual(arrowSyms[0].id, arrowSyms[1].id, "Same-line symbols must have different unique IDs");
    assert.equal(arrowSyms[0].line, arrowSyms[1].line, "Both anonymous arrows must be on the exact same line");

    // Check constructor symbol exists
    const ctorSym = result.symbols.find((s) => s.name === "constructor" && s.kind === "constructor");
    assert.ok(ctorSym, "Constructor symbol must be detected");

    // Check new ServiceWorker() points to constructor
    const newCall = result.calls.find((c) => c.to === ctorSym.id);
    assert.ok(newCall, "Call from entrypoint with `new ServiceWorker` should point to constructor");

    // Check arrow function call resolved: entrypoint -> helperArrow
    const arrowSym = result.symbols.find((s) => s.name === "helperArrow");
    assert.ok(arrowSym, "helperArrow symbol must be detected");
    const arrowCall = result.calls.find((c) => c.to === arrowSym.id);
    assert.ok(arrowCall, "helperArrow call should be resolved in static call graph");

    // Verify comments and strings do NOT create fake calls
    const fakeCall = result.calls.find((c) => c.to.includes("runFake") || c.to.includes("fakeCallInsideString"));
    assert.equal(fakeCall, undefined, "Comments and string literals must never create fake call edges");

    // Check unresolved calls categories
    const dynCall = result.unresolvedCalls.find((u) => u.reason === "dynamic");
    assert.ok(dynCall, "Dynamic call obj['dynamicMethod']() should be categorized as dynamic");

    const extCall = result.unresolvedCalls.find((u) => u.reason === "external");
    assert.ok(extCall, "console.log() should be categorized as external");

    const unresCall = result.unresolvedCalls.find((u) => u.reason === "unresolved");
    assert.ok(unresCall, "unresolvedFunctionCall() should be categorized as unresolved");

    // Check syntax error diagnostics reported in Russian
    const synDiag = result.analysis.diagnostics.find((d) => d.file === "syntaxErr.js");
    assert.ok(synDiag, "Syntactic diagnostics should be captured for broken syntax file");
    assert.ok(synDiag.message.includes("Синтаксис:"), "Diagnostic message should be formatted in Russian");
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("analyzeProjectJsTs: import alias, re-export, and variable shadowing", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "archmap-alias-test-"));
  try {
    // moduleA: defines baseFunction
    const modA = `
export function baseFunction() {
  return "origin";
}
`;
    // moduleB: re-exports baseFunction as reexportedFunc
    const modB = `
export { baseFunction as reexportedFunc } from "./moduleA.js";
`;
    // consumer: imports reexportedFunc with local alias aliasedFunc, and shadows it locally
    const consumer = `
import { reexportedFunc as aliasedFunc } from "./moduleB.js";

export function testCaller() {
  aliasedFunc(); // Should point to baseFunction in moduleA

  function shadowTest() {
    const aliasedFunc = () => "shadowed";
    aliasedFunc(); // Local shadowed arrow, must NOT link to moduleA.baseFunction
  }
  shadowTest();
}
`;

    writeFileSync(join(testDir, "moduleA.js"), modA, "utf8");
    writeFileSync(join(testDir, "moduleB.js"), modB, "utf8");
    writeFileSync(join(testDir, "consumer.js"), consumer, "utf8");

    const result = await analyzeProjectJsTs(testDir, ["moduleA.js", "moduleB.js", "consumer.js"]);
    assert.ok(result);

    const baseFuncSym = result.symbols.find((s) => s.file === "moduleA.js" && s.name === "baseFunction");
    const testCallerSym = result.symbols.find((s) => s.file === "consumer.js" && s.name === "testCaller");
    const shadowTestSym = result.symbols.find((s) => s.file === "consumer.js" && s.name === "shadowTest");
    const shadowedArrowSym = result.symbols.find((s) => s.file === "consumer.js" && s.name === "aliasedFunc" && s.kind === "arrow");

    assert.ok(baseFuncSym, "baseFunction symbol in moduleA must be detected");
    assert.ok(testCallerSym, "testCaller symbol in consumer must be detected");
    assert.ok(shadowTestSym, "shadowTest symbol in consumer must be detected");
    assert.ok(shadowedArrowSym, "shadowed aliasedFunc arrow symbol must be detected");

    // Verify call from testCaller reaches baseFunction via re-export + import alias
    const callToBase = result.calls.find((c) => c.from === testCallerSym.id && c.to === baseFuncSym.id);
    assert.ok(callToBase, "Call through re-export and import alias must resolve to baseFunction in moduleA");

    // Verify shadowed call in shadowTest points to local arrow, NOT moduleA.baseFunction
    const callInShadow = result.calls.find((c) => c.from === shadowTestSym.id && c.to === baseFuncSym.id);
    assert.equal(callInShadow, undefined, "Shadowed call must not resolve to shadowed outer/imported symbol");

    const callToLocalArrow = result.calls.find((c) => c.from === shadowTestSym.id && c.to === shadowedArrowSym.id);
    assert.ok(callToLocalArrow, "Shadowed call must resolve to local arrow declaration");
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("analyzeProjectJsTs: extensionless TS import, static method call, and reciprocal cyclic imports", async () => {
  const testDir = join(process.cwd(), ".test-fixture-ts-cycle-" + Date.now());
  mkdirSync(join(testDir, "src", "services"), { recursive: true });
  mkdirSync(join(testDir, "src", "shared"), { recursive: true });
  mkdirSync(join(testDir, "src", "api"), { recursive: true });

  try {
    const moneyTs = `export class Money {
  static of(n: number): Money { return new Money(n); }
  constructor(public readonly v: number) {}
}`;
    const pricingTs = `import { Money } from "../shared/money";
import { applyPromo } from "../api/promo";

export function priceOrder(base: number): number {
  const m = Money.of(base);
  return applyPromo(m.v);
}`;
    const promoTs = `import { priceOrder } from "../services/pricing";

export function applyPromo(val: number): number {
  if (val > 100) return priceOrder(val - 10);
  return val * 0.9;
}`;

    writeFileSync(join(testDir, "src", "shared", "money.ts"), moneyTs, "utf8");
    writeFileSync(join(testDir, "src", "services", "pricing.ts"), pricingTs, "utf8");
    writeFileSync(join(testDir, "src", "api", "promo.ts"), promoTs, "utf8");

    const rel = [
      "src/shared/money.ts",
      "src/services/pricing.ts",
      "src/api/promo.ts",
    ];

    const result = await analyzeProjectJsTs(testDir, rel);
    assert.ok(result, "Result should exist");

    const priceOrderSym = result.symbols.find((s) => s.file === "src/services/pricing.ts" && s.name === "priceOrder");
    const staticOfSym = result.symbols.find((s) => s.file === "src/shared/money.ts" && s.name === "of" && s.kind === "method");
    const applyPromoSym = result.symbols.find((s) => s.file === "src/api/promo.ts" && s.name === "applyPromo");

    assert.ok(priceOrderSym, "priceOrder symbol must exist");
    assert.ok(staticOfSym, "Money.of static method symbol must exist");
    assert.ok(applyPromoSym, "applyPromo symbol must exist");

    // Assert exact call endpoints for static method Money.of
    const callToStaticOf = result.calls.find((c) => c.from === priceOrderSym.id && c.to === staticOfSym.id);
    assert.ok(callToStaticOf, "priceOrder must resolve call to static method Money.of across extensionless TS import");

    // Assert exact reciprocal cyclic call endpoints
    const callPricingToPromo = result.calls.find((c) => c.from === priceOrderSym.id && c.to === applyPromoSym.id);
    assert.ok(callPricingToPromo, "priceOrder must resolve call to applyPromo across extensionless TS import");

    const callPromoToPricing = result.calls.find((c) => c.from === applyPromoSym.id && c.to === priceOrderSym.id);
    assert.ok(callPromoToPricing, "applyPromo must resolve reciprocal cyclic call to priceOrder");
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("analyzeProjectJsTs: fileDeps resolves tsconfig paths alias, re-export chain, side-effect import, and excludes external packages", async () => {
  const testDir = join(process.cwd(), ".test-fixture-deps-" + Date.now());
  mkdirSync(join(testDir, "src", "lib"), { recursive: true });
  mkdirSync(join(testDir, "src", "shared"), { recursive: true });
  mkdirSync(join(testDir, "node_modules", "left-pad"), { recursive: true });

  const write = (rel, src) => {
    const full = join(testDir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, src, "utf8");
  };

  try {
    write("tsconfig.json", JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        baseUrl: "src",
        paths: { "@shared/*": ["shared/*"] },
      },
      include: ["src"],
    }, null, 2));
    // External package must never appear as a project edge.
    write("node_modules/left-pad/package.json", JSON.stringify({ name: "left-pad", main: "index.js" }));
    write("node_modules/left-pad/index.js", "module.exports = (s) => s;\n");

    write("src/shared/money.ts", "export const CURRENCY = 'EUR';\nexport function format(n: number): string { return n.toFixed(2); }\n");
    // Barrel re-exports across a directory boundary (extensionless, alias-relative).
    write("src/shared/index.ts", "export { format } from './money';\n");
    // Import via tsconfig path alias, plus a side-effect-only import of an internal module, plus an external package.
    write("src/lib/checkout.ts", [
      "import leftPad from 'left-pad';",
      "import { format } from '@shared/index';",
      "import './side-effects';",
      "",
      "export function total(n: number): string {",
      "  const padded = leftPad('x');",
      "  if (padded.length < 2) throw new Error('never');",
      "  return format(n);",
      "}",
      "",
    ].join("\n"));
    write("src/lib/side-effects.ts", "export const registered = true;\n");
    // ESM extension substitution: "./money.js" must resolve to src/shared/money.ts.
    write("src/lib/ledger.mts", "import { CURRENCY } from '../shared/money.js';\n\nexport const currency = CURRENCY;\n");

    const rel = [
      "src/shared/money.ts",
      "src/shared/index.ts",
      "src/lib/checkout.ts",
      "src/lib/side-effects.ts",
      "src/lib/ledger.mts",
    ];

    const result = await analyzeProjectJsTs(testDir, rel, {});
    assert.ok(result && result.fileDeps, "fileDeps must be returned");

    const deps = (p) => result.fileDeps[p] || [];
    assert.deepEqual(
      [...deps("src/lib/checkout.ts")].sort(),
      ["src/lib/side-effects.ts", "src/shared/index.ts"],
      "path alias and side-effect imports must resolve to project files; external left-pad must be excluded"
    );
    assert.ok(
      !Object.values(result.fileDeps).flat().some((d) => d.includes("node_modules")),
      "node_modules must never appear in fileDeps"
    );

    assert.deepEqual(
      [...deps("src/shared/index.ts")].sort(),
      ["src/shared/money.ts"],
      "re-export chain must produce an edge to the barrel's own target"
    );

    assert.deepEqual(
      [...deps("src/lib/ledger.mts")].sort(),
      ["src/shared/money.ts"],
      ".mts file must be scanned and its ESM-style .js specifier resolved to the .ts source"
    );

    assert.deepEqual(deps("src/shared/money.ts"), [], "leaf module has no internal deps");

    // End-to-end: the scanner itself must merge compiler-resolved deps into the module graph.
    // Driven through the real CLI (the scanner is not a public module export).
    const cli = fileURLToPath(new URL("../archmap.mjs", import.meta.url));
    const proc = spawnSync(process.execPath, [cli, "scan", "--root", testDir], { encoding: "utf8" });
    assert.equal(proc.status, 0, `archmap scan must succeed; stderr: ${proc.stderr}`);

    const state = JSON.parse(readFileSync(join(testDir, ".archmap", "state.json"), "utf8"));
    const checkout = state.files["src/lib/checkout.ts"];
    assert.ok(checkout, "scanner must include checkout.ts");
    assert.ok(
      checkout.deps.includes("src/shared/index.ts") && checkout.deps.includes("src/lib/side-effects.ts"),
      `scanner must merge alias + side-effect deps into files[].deps; got ${JSON.stringify(checkout.deps)}`
    );
    assert.ok(
      !Object.values(state.files).flatMap((f) => f.deps).some((d) => d.includes("node_modules")),
      "module graph must contain no external edges"
    );
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});
