import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeProblems, redactSecrets } from "../archmap-problems.mjs";
import { loadCache, saveCache } from "../archmap-cache.mjs";

test("archmap-problems: redactSecrets masks secret patterns with [REDACTED]", () => {
  const code = `const apiKey = "sk_live_1234567890abcdef1234567890abcdef";\nconst token = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";`;
  const redacted = redactSecrets(code);
  assert.ok(!redacted.includes("sk_live_1234567890abcdef1234567890abcdef"), "Secret apiKey must be redacted");
  assert.ok(!redacted.includes("ghp_abcdefghijklmnopqrstuvwxyz1234567890"), "Secret token must be redacted");
  assert.ok(redacted.includes("[REDACTED]"), "Must contain [REDACTED]");
});

test("archmap-problems: generates all 5 categories (structure, optimization, security, reliability, maintainability)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "archmap-prob-test-"));
  try {
    mkdirSync(join(tempDir, "src"), { recursive: true });

    // File 1: security issues (eval, hardcoded secret, innerHTML)
    writeFileSync(join(tempDir, "src/security.js"), `
      const token = "$$CREDENTIAL_02MCE0P7G0B1:L$$";
      eval("window.x = 1");
      document.body.innerHTML = "<div>hello</div>";
    `);

    // File 2: reliability issues (empty catch, swallowed error, TODO/FIXME)
    writeFileSync(join(tempDir, "src/reliability.js"), `
      // TODO: fix something
      // FIXME: broken item
      try {
        doSomething();
      } catch (e) {
      }
      try {
        doOther();
      } catch (err) {
        console.log(err);
      }
    `);

    // File 3: optimization issues (complexity > 60, long function)
    let complexCode = "function huge() {\n";
    for (let i = 0; i < 70; i++) {
      complexCode += `  if (Math.random() > 0.5) { console.log(${i}); }\n`;
    }
    complexCode += "}\n";
    writeFileSync(join(tempDir, "src/optimization.js"), complexCode);

    // File 4: maintainability issue (low MI) & wrapper
    let lowMiCode = "import { a } from './security.js';\nexport function f() { return a; }\n";
    for (let i = 0; i < 400; i++) {
      lowMiCode += `// line ${i}\n`;
    }
    writeFileSync(join(tempDir, "src/maintainability.js"), lowMiCode);

    // State setup for analyzeProblems
    const mockState = {
      root: tempDir,
      totals: { files: 4, loc: 600, avgMi: 50 },
      cycles: [
        ["src/security.js", "src/reliability.js"], // cycle of length 2 -> high
        ["src/a.js", "src/b.js", "src/c.js", "src/d.js", "src/e.js"] // cycle of length 5 -> critical
      ],
      files: {
        "src/security.js": { loc: 10, complexity: 2, imports: 0, exports: 0, deps: ["src/reliability.js"], fanIn: 1, fanOut: 1, mi: 80 },
        "src/reliability.js": { loc: 20, complexity: 5, imports: 0, exports: 0, deps: ["src/security.js"], fanIn: 1, fanOut: 1, mi: 75 },
        "src/optimization.js": { loc: 80, complexity: 72, imports: 0, exports: 0, deps: [], fanIn: 0, fanOut: 0, mi: 60 },
        "src/maintainability.js": { loc: 410, complexity: 20, imports: 1, exports: 1, deps: ["src/security.js"], fanIn: 0, fanOut: 1, mi: 15 },
        "src/orphan.js": { loc: 20, complexity: 1, imports: 0, exports: 0, deps: [], fanIn: 0, fanOut: 0, mi: 85 }
      },
      symbols: [
        { id: "sym-1", file: "src/optimization.js", name: "huge", kind: "Function", line: 1, endLine: 75 }
      ]
    };

    const problems = analyzeProblems(mockState, tempDir);

    const categories = new Set(problems.map(p => p.category));
    assert.ok(categories.has("structure"), "Must have structure problem");
    assert.ok(categories.has("optimization"), "Must have optimization problem");
    assert.ok(categories.has("security"), "Must have security problem");
    assert.ok(categories.has("reliability"), "Must have reliability problem");
    assert.ok(categories.has("maintainability"), "Must have maintainability problem");

    // Severity mapping check
    const severities = new Set(problems.map(p => p.severity));
    assert.ok(severities.has("critical"), "Must have critical severity (from cycle > 4)");
    assert.ok(severities.has("high"), "Must have high severity (eval / cycle <= 4 / complexity >= 60)");
    assert.ok(severities.has("medium"), "Must have medium severity (swallowed error / innerHTML)");
    assert.ok(severities.has("low"), "Must have low severity (orphan / TODO)");

    // Deterministic sort: critical -> high -> medium -> low
    const orderMap = { critical: 0, high: 1, medium: 2, low: 3 };
    for (let i = 0; i < problems.length - 1; i++) {
      const curOrder = orderMap[problems[i].severity];
      const nextOrder = orderMap[problems[i + 1].severity];
      assert.ok(curOrder <= nextOrder, `Sort violated at index ${i}: ${problems[i].severity} before ${problems[i + 1].severity}`);
    }

    // Prompt content check: Russian prompt, contains file+line+fix and no secret values
    for (const prob of problems) {
      assert.ok(prob.prompt, `Problem ${prob.id} must have a prompt`);
      assert.ok(prob.prompt.includes("Файл:"), `Prompt must specify file location`);
      assert.ok(prob.prompt.includes("Как исправить:"), `Prompt must specify fix`);
      assert.ok(!prob.prompt.includes("$$CREDENTIAL_02MCE0P7G0B1:L$$"), `Prompt must not leak secret value`);
      assert.strictEqual(prob.heuristic, true, `Problem must declare heuristic: true`);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("archmap-cache: saveCache and loadCache persist entries and version", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "archmap-cache-test-"));
  try {
    const data = {
      version: 1,
      entries: {
        "src/a.ts": { hash: "h1", members: ["A"], imports: ["./b"], exports: ["A"] }
      }
    };
    saveCache(tempDir, data);
    const loaded = loadCache(tempDir);
    assert.strictEqual(loaded.version, 1);
    assert.deepStrictEqual(loaded.entries["src/a.ts"], data.entries["src/a.ts"]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
