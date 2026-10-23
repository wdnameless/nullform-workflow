#!/usr/bin/env node
/**
 * tools/audit-profile.mjs — audit-профиль verify.mjs (выделен из монолита 1:1).
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  realpathSync
} from "node:fs";
import { join } from "node:path";
import {
  NotConfiguredError,
  runProc,
  runPromptLint,
  checkSyncDrift,
  checkSkillsDoctor,
  testTierGate,
  executeCheck,
  invokeDoctor
} from "./verify-shared.mjs";

export async function runAuditProfile(ctx) {
  const { harnessRoot, repoRoot, userHome, agentDir, scope } = ctx;
  const results = [];

  // 1 harness/repo drift
  results.push(
    await executeCheck(1, "harness/repo drift", () => {
      const harnessIsRepo = harnessRoot.toLowerCase() === repoRoot.toLowerCase();
      if (harnessIsRepo || !existsSync(join(repoRoot, "install.ps1"))) {
        return { ok: true, detail: "n/a (no separate harness to compare)" };
      }
      return checkSyncDrift(repoRoot, harnessRoot, userHome);
    })
  );

  // 2 prompt volatile literals
  results.push(
    await executeCheck(2, "prompt volatile literals", () => {
      const tool = join(harnessRoot, "tools", "prompt-lint.mjs");
      const r = runPromptLint(tool, userHome, ["scan", "--root", harnessRoot]);
      return {
        ok: r.status === 0,
        detail: r.status === 0 ? "none" : "volatile content in a prompt surface",
      };
    })
  );

  // 3 prompt-cache baseline
  results.push(
    await executeCheck(3, "prompt-cache baseline", () => {
      const baseline = join(harnessRoot, ".prompt-lint", "baseline.json");
      if (!existsSync(baseline)) {
        return { ok: true, detail: "n/a (no baseline in this tree)" };
      }
      const tool = join(harnessRoot, "tools", "prompt-lint.mjs");
      const r = runPromptLint(tool, userHome, ["check", "--root", harnessRoot]);
      return {
        ok: r.status === 0,
        detail: r.status === 0 ? "matches" : "surfaces drifted - re-run baseline if intentional",
      };
    })
  );

  // 4 skills registry
  results.push(
    await executeCheck(4, "skills registry", () => {
      const r = checkSkillsDoctor(harnessRoot, userHome, repoRoot);
      return {
        ok: r.status === 0,
        detail: r.status === 0 ? "healthy" : "unparsable/truncated/orphan skills",
      };
    })
  );

  // 5 CONTEXT.md coverage
  results.push(
    await executeCheck(5, "CONTEXT.md coverage", () => {
      const effectiveScope = scope && scope.length ? scope : ["agent", "tools"];
      const tool = join(harnessRoot, "tools", "glossary.mjs");
      const r = runProc(process.execPath, [
        tool,
        "check",
        "--root",
        repoRoot,
        "--scope",
        effectiveScope.join(","),
      ]);
      let detail;
      if (r.status === 0) {
        detail = `all documented (${effectiveScope.join(",")})`;
      } else if (r.status === 2) {
        // A missing glossary is an intended, non-failing state (AGENTS.md: "do not create
        // one unprompted"), but reporting it as PASS made the audit claim coverage it never
        // measured. SETUP states the truth: nothing to check yet.
        throw new NotConfiguredError("no CONTEXT.md - nothing to check yet");
      } else {
        detail = "undocumented public symbols";
      }
      return {
        ok: r.status === 0,
        detail,
      };
    })
  );

  // 6 tier gate present and working
  results.push(
    await executeCheck(6, "tier gate present and working", () => {
      try {
        const detail = testTierGate(harnessRoot, false);
        return { ok: true, detail };
      } catch (e) {
        return { ok: false, detail: e.message };
      }
    })
  );

  // 7 debt ledger tool
  results.push(
    await executeCheck(7, "debt ledger tool", () => {
      const dl = join(harnessRoot, "tools", "debt-ledger.mjs");
      if (!existsSync(dl)) return { ok: false, detail: "debt-ledger.mjs missing" };
      return { ok: true, detail: "debt-ledger.mjs present" };
    })
  );

  // 8 benchmark tool
  results.push(
    await executeCheck(8, "benchmark tool", () => {
      const bm = join(harnessRoot, "tools", "benchmark.mjs");
      if (!existsSync(bm)) return { ok: false, detail: "benchmark.mjs missing" };
      return { ok: true, detail: "benchmark.mjs present" };
    })
  );

  // 9 portable core specification
  results.push(
    await executeCheck(9, "portable core specification", () => {
      const cp = join(harnessRoot, "core", "PORTABLE.md");
      const rel = join("core", "PORTABLE.md");
      if (!existsSync(cp)) return { ok: false, detail: `${rel} missing` };
      return { ok: true, detail: `${rel} present` };
    })
  );

  // 9b code size gate — runs the tool, not merely checks that it exists.
  // Checking for the file would repeat the false-pass pattern this audit removed from
  // checks 4/5/10: "the tool is present" says nothing about whether the code is growing.
  results.push(
    await executeCheck("9b", "code size gate (no module growth past baseline)", () => {
      const tool = join(harnessRoot, "tools", "code-size.mjs");
      if (!existsSync(tool)) throw new NotConfiguredError("code-size.mjs not installed");
      // The tool exits 1 with the violation list on stderr; no need to re-parse its JSON.
      const r = runProc(process.execPath, [tool, "check", "--root", repoRoot]);
      const out = `${r.stdout || ""}${r.stderr || ""}`;
      const first = out.split("\n").find((l) => l.includes("[FAIL]"))?.trim() || "";
      if (r.status !== 0) throw new Error(first || `code-size exited ${r.status}`);
      const n = out.match(/Проверено (\d+) файлов/)?.[1] ?? "?";
      return `${n} files, no growth past baseline`;
    })
  );

  // 10 codemap currency
  results.push(
    await executeCheck(10, "codemap currency", () => {
      const state = join(repoRoot, ".codemap", "state.json");
      if (!existsSync(state)) return { ok: true, detail: "not initialised (optional)" };
      const cm = join(harnessRoot, "tools", "codemap.mjs");
      const r = runProc(process.execPath, [cm, "changes", "--root", repoRoot]);
      const text = (r.stdout || "") + (r.stderr || "");
      const m = text.match(/changes:\s*\+(\d+)\s*~(\d+)\s*-(\d+)/);
      if (!m) return { ok: true, detail: "no change data" };
      const n = parseInt(m[1], 10) + parseInt(m[2], 10) + parseInt(m[3], 10);
      return {
        // Stale is stale: reporting ok:true with a "may be stale" note made the audit
        // list a drifted map as clean.
        ok: n === 0,
        detail: n === 0 ? "current" : `${n} file(s) changed - CODEMAP.md is stale`,
      };
    })
  );

  // 11 oracle model role
  results.push(
    await executeCheck(11, "oracle model role", () => {
      const scriptPath = join(harnessRoot, "tools", "oracle-model.mjs");
      if (!existsSync(scriptPath)) {
        return { ok: true, detail: "oracle-model.mjs not found (optional)" };
      }
      const modelsPath = join(userHome, ".omp", "agent", "models.yml");
      const configPath = join(userHome, ".omp", "agent", "config.yml");
      if (!existsSync(modelsPath) || !existsSync(configPath)) {
        return { ok: true, detail: "n/a (no provider configured)" };
      }
      const r = runProc(process.execPath, [scriptPath, "list", "--json", "--probe"]);
      if (r.status !== 0) {
        return { ok: false, detail: `oracle-model list failed with exit ${r.status}` };
      }
      try {
        const json = JSON.parse(r.stdout);
        if (json.isFallback) return { ok: true, detail: "fallback" };
        if (json.resolved) return { ok: true, detail: `oracle=${json.resolved}` };
        return { ok: true, detail: "fallback" };
      } catch (e) {
        return { ok: false, detail: `failed to parse oracle-model json output: ${e.message}` };
      }
    })
  );

  // 12 usage audit tool
  results.push(
    await executeCheck(12, "usage audit tool", () => {
      const ua = join(harnessRoot, "tools", "usage-audit.mjs");
      if (!existsSync(ua)) return { ok: false, detail: "usage-audit.mjs missing" };
      return { ok: true, detail: "usage-audit.mjs present" };
    })
  );

  // 13 install doctor
  results.push(
    await executeCheck(13, "install doctor", () => {
      const resolved = agentDir || (userHome ? join(userHome, ".omp", "agent") : null);
      if (!resolved || !existsSync(join(resolved, ".harness-root"))) return { ok: true, detail: "n/a (no installed agent dir)" };
      const { exists, res } = invokeDoctor(harnessRoot, resolved, userHome);
      if (!exists) return { ok: false, detail: "doctor.mjs missing" };
      if (res.status !== 0) return { ok: false, detail: `doctor check failed with exit ${res.status}` };
      const json = JSON.parse(res.stdout || "{}");
      return json.ok ? { ok: true, detail: `clean (${json.summary?.pass} pass)` } : { ok: false, detail: `${json.summary?.fail} check(s) failed` };
    })
  );

  // 14 prompt budget
  results.push(
    await executeCheck(14, "prompt budget", () => {
      const pl = join(harnessRoot, "tools", "prompt-lint.mjs");
      if (!existsSync(pl)) return { ok: false, detail: "prompt-lint.mjs missing" };
      const r = runProc(process.execPath, [pl, "sizes", "--root", harnessRoot, "--check"]);
      if (r.status !== 0) {
        return { ok: false, detail: `prompt budget check failed (exit ${r.status})` };
      }
      return { ok: true, detail: "within budget" };
    })
  );

  return results;
}
