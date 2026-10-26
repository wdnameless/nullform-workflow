#!/usr/bin/env node
/**
 * tools/verify-profile.mjs — verify-профиль verify.mjs (выделен из монолита 1:1).
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
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

function runOmp(args = [], options = {}) {
  const isWin = process.platform === "win32";
  if (isWin) {
    const appData = process.env.APPDATA || "";
    const omp = join(appData, "npm", "omp.cmd");
    const cmdStr = existsSync(omp)
      ? `"${omp}" ${args.join(" ")}`
      : `omp ${args.join(" ")}`;
    return spawnSync(cmdStr, {
      shell: true,
      encoding: "utf8",
      windowsHide: true,
      ...options,
    });
  }
  return spawnSync("omp", args, {
    encoding: "utf8",
    ...options,
  });
}

function runOpenspec(args = [], options = {}) {
  const isWin = process.platform === "win32";
  if (isWin) {
    return spawnSync("cmd.exe", ["/d", "/s", "/c", `openspec ${args.join(" ")}`], {
      encoding: "utf8",
      windowsHide: true,
      ...options,
    });
  }
  return spawnSync("openspec", args, {
    encoding: "utf8",
    ...options,
  });
}

/** Exercise auto-review's debt gate: `clean` passes a native node:test product
 *  check; `gate` adds an untriggered defer marker so the debt gate must fail. */
const AR_FIXTURE_SRC = 'export function add(a, b) { return a + b; }\n';
const AR_FIXTURE_TEST = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./fixture.mjs";\ntest("add", () => assert.equal(add(2, 3), 5));\n';

function runAutoReviewFixtureCheck(harnessRoot) {
  const tool = join(harnessRoot, "tools", "auto-review.mjs");
  if (!existsSync(tool)) throw new Error("tools/auto-review.mjs not found");
  const cases = [
    { dir: mkdtempSync(join(tmpdir(), "ar-clean-")), marker: "", expect: 0 },
    { dir: mkdtempSync(join(tmpdir(), "ar-gate-")), marker: "\n// defer: no trigger", expect: 1 },
  ];
  try {
    for (const { dir, marker, expect } of cases) {
      writeFileSync(join(dir, "fixture.mjs"), `${AR_FIXTURE_SRC}${marker}\n`, "utf8");
      writeFileSync(join(dir, "fixture.test.mjs"), AR_FIXTURE_TEST, "utf8");
      const res = runProc(process.execPath, [tool, "--root", dir, "--check", JSON.stringify(["node", "--test", join(dir, "fixture.test.mjs")])]);
      if (res.status !== expect) throw new Error(`fixture ${dir} exit ${res.status}, expected ${expect}`);
    }
    return "clean=0 gate=1";
  } finally {
    for (const { dir } of cases) try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function readModelsYaml(agentDir) {
  const p = join(agentDir, "models.yml");
  if (!existsSync(p)) {
    throw new NotConfiguredError(
      "no provider yet - re-run install.ps1 with a base URL + key + model id"
    );
  }
  return readFileSync(p, "utf8");
}

export async function runVerifyProfile(ctx) {
  const { harnessRoot, repoRoot, userHome, agentDir } = ctx;
  const results = [];

  // 1 node present (harness tools are Node scripts)
  results.push(
    await executeCheck(1, "node present (harness tools are Node scripts)", () => {
      const r = runProc(process.execPath, ["--version"]);
      if (r.status !== 0) throw new Error("node not runnable");
      return r.stdout.trim();
    })
  );

  // 2 openspec present (T2 4-Wave protocol)
  results.push(
    await executeCheck(2, "openspec present (T2 4-Wave protocol)", () => {
      const r = runOpenspec(["--version"]);
      const out = (r.stdout || "").trim();
      if (r.status !== 0 || !/^\d+\./.test(out)) throw new Error("openspec not runnable");
      return `openspec ${out}`;
    })
  );

  // 3 agent definitions present
  results.push(
    await executeCheck(3, "agent definitions present", () => {
      const required = [
        "orchestrator",
        "fixer",
        "designer",
        "oracle",
        "librarian",
        "explorer",
        "reviewer",
      ];
      const agentsDir = join(agentDir, "agents");
      let present = [];
      if (existsSync(agentsDir)) {
        present = readdirSync(agentsDir)
          .filter((f) => f.endsWith(".md"))
          .map((f) => basename(f, ".md"));
      }
      const missing = required.filter((role) => !present.includes(role));
      if (missing.length) {
        throw new Error(`missing required roles: ${missing.join(", ")}`);
      }
      return `${present.length} roles, all required roles present (${required.length} required; sonic is our optional fork)`;
    })
  );

  // 4 every agent def has name + description
  results.push(
    await executeCheck(4, "every agent def has name + description", () => {
      const agentsDir = join(agentDir, "agents");
      // An absent directory means the check cannot run — that is a FAILURE, not a pass.
      // Skipping the loop silently reported "every definition is valid" when there were none.
      if (!existsSync(agentsDir)) {
        throw new Error(`agent definitions directory missing: ${agentsDir}`);
      }
      const files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
      if (files.length === 0) {
        throw new Error(`no agent definitions in ${agentsDir}`);
      }
      const bad = [];
      for (const f of files) {
        const raw = readFileSync(join(agentsDir, f), "utf8");
        const head = raw.split(/\r?\n/).slice(0, 8);
        const hasName = head.some((line) => /^name:/.test(line));
        const hasDesc = head.some((line) => /^description:/.test(line));
        if (!hasName || !hasDesc) bad.push(f);
      }
      if (bad.length) throw new Error(`missing frontmatter: ${bad.join(", ")}`);
      return `${files.length} definitions valid`;
    })
  );

  // 5 skills registry populated (>= 20)
  results.push(
    await executeCheck(5, "skills registry populated (>= 20)", () => {
      const skillsDir = join(userHome, ".agents", "skills");
      let n = 0;
      if (existsSync(skillsDir)) {
        n = readdirSync(skillsDir, { withFileTypes: true }).filter((d) =>
          d.isDirectory()
        ).length;
      }
      if (n < 20) throw new Error(`only ${n} skills installed`);
      return `${n} skills`;
    })
  );

  // 6 skills registry healthy (frontmatter/truncation/parity/orphans)
  results.push(
    await executeCheck(
      6,
      "skills registry healthy (frontmatter/truncation/parity/orphans)",
      () => {
        const r = checkSkillsDoctor(harnessRoot, userHome, repoRoot);
        if (r.status !== 0) {
          const lines = (r.stdout + "\n" + r.stderr)
            .split(/\r?\n/)
            .filter((l) => /\S/.test(l));
          throw new Error(lines.slice(-4).join(" | "));
        }
        return "healthy";
      }
    )
  );

  // 7 workflow skills registered
  results.push(
    await executeCheck(7, "workflow skills registered", () => {
      const want = [
        "grill-me",
        "grilling",
        "codebase-design",
        "diagnosing-bugs",
        "domain-modeling",
        "codemap",
        "deepwork",
      ];
      const missing = want.filter(
        (s) => !existsSync(join(userHome, ".agents", "skills", s, "SKILL.md"))
      );
      if (missing.length) throw new Error(`missing: ${missing.join(", ")}`);
      return `${want.length} present`;
    })
  );

  // 8 rule installed and addressable
  results.push(
    await executeCheck(8, "rule installed and addressable", () => {
      let p = join(agentDir, "rules", "enterprise-directives.md");
      if (!existsSync(p)) p = join(userHome, ".agents", "rules", "enterprise-directives.md");
      if (!existsSync(p)) throw new Error("rule not found");
      const head = readFileSync(p, "utf8").split(/\r?\n/).slice(0, 3).join("\n");
      if (!/description:/.test(head)) {
        throw new Error("no description frontmatter (rule:// will not resolve)");
      }
      return true;
    })
  );

  function readMcpServers(notConfiguredIfMissing = false) {
    const p = join(agentDir, "mcp.json");
    if (!existsSync(p)) {
      if (notConfiguredIfMissing) throw new NotConfiguredError("mcp.json missing - no servers configured");
      throw new Error("mcp.json missing");
    }
    try {
      const m = JSON.parse(readFileSync(p, "utf8"));
      return m.mcpServers || {};
    } catch (e) {
      throw new Error(`mcp.json parse error: ${e.message}`);
    }
  }

  // 9 mcp.json parses, entries well-formed
  results.push(
    await executeCheck(9, "mcp.json parses, entries well-formed", () => {
      const servers = readMcpServers(false);
      const names = Object.keys(servers);
      if (names.length === 0) throw new Error("no MCP servers configured");
      const bad = [];
      for (const n of names) {
        const e = servers[n];
        if (e.url) {
          if (/__[A-Z0-9_]+__/.test(e.url)) bad.push(`${n}(url placeholder)`);
        } else if (!e.command) {
          bad.push(`${n}(no command or url)`);
        }
      }
      if (bad.length) throw new Error(`malformed: ${bad.join(", ")}`);
      return `${names.length} servers: ${names.join(", ")}`;
    })
  );

  // 10 no MCP server pinned to @latest
  results.push(
    await executeCheck(10, "no MCP server pinned to @latest", () => {
      const servers = readMcpServers(true);
      const bad = [];
      for (const [n, entry] of Object.entries(servers)) {
        const a = entry.args;
        if (Array.isArray(a) && a.join(" ").includes("@latest")) bad.push(n);
      }
      if (bad.length) throw new Error(`unpinned: ${bad.join(", ")} - pin the version`);
      return true;
    })
  );

  // 11 mandatory MCP servers present
  results.push(
    await executeCheck(11, "mandatory MCP servers present", () => {
      const servers = readMcpServers(false);
      const names = Object.keys(servers);
      const mandatory = ["chrome-devtools"];
      const missing = mandatory.filter((req) => !names.includes(req));
      if (missing.length) throw new Error(`missing mandatory MCP server(s): ${missing.join(", ")}`);
      return `present: ${mandatory.join(", ")}`;
    })
  );

  // 12 models.yml is map-form with no placeholders
  results.push(
    await executeCheck(12, "models.yml is map-form with no placeholders", () => {
      const y = readModelsYaml(agentDir);
      const ph = y.match(/__[A-Z0-9_]+__/g) || [];
      if (ph.length) throw new Error(`placeholders remain: ${ph.slice(0, 3).join(", ")}`);
      if (!/(^|\n)providers:\s*(\r?\n|$)/m.test(y)) {
        throw new Error("no top-level 'providers:' key (list-form?)");
      }
      return true;
    })
  );

  // 13 no unsubstituted placeholders across installed configs
  results.push(
    await executeCheck(13, "no unsubstituted placeholders across installed configs", () => {
      const bad = [];
      for (const f of ["models.yml", "mcp.json", "config.yml"]) {
        const fp = join(agentDir, f);
        if (existsSync(fp)) {
          const raw = readFileSync(fp, "utf8");
          const m = raw.match(/__[A-Z0-9_]+__/g);
          if (m && m.length) bad.push(`${f}(${m.length})`);
        }
      }
      if (bad.length) throw new Error(`unsubstituted: ${bad.join(", ")}`);
      return true;
    })
  );

  // 14 declared provider resolves in the live registry
  results.push(
    await executeCheck(14, "declared provider resolves in the live registry", () => {
      const y = readModelsYaml(agentDir);
      const m = y.match(
        /(?:^|\n)providers:\s*(?:\r?\n(?:\s*#.*|\s*)?)*\r?\n(?:\s*#.*\r?\n)*\s{2}([a-z0-9][a-z0-9._-]*):/
      );
      const provId = m ? m[1] : null;
      if (!provId) throw new Error("cannot read provider id from models.yml");
      const r = runOmp(["models", "find", provId]);
      const text = (r.stdout || "") + (r.stderr || "");
      if (!text.includes(provId)) throw new Error(`provider '${provId}' not in the live registry`);
      return provId;
    })
  );

  // 15 provider baseUrl declared (reachability informational)
  results.push(
    await executeCheck(15, "provider baseUrl declared (reachability informational)", async () => {
      const y = readModelsYaml(agentDir);
      const m = y.match(/baseUrl:\s*(\S+)/);
      const u = m ? m[1] : null;
      if (!u) throw new Error("no baseUrl declared in models.yml");
      if (/__[A-Z0-9_]+__/.test(u)) throw new Error("baseUrl is still a placeholder");
      if (!/^https?:\/\//i.test(u)) throw new Error(`baseUrl is not an http(s) URL: ${u}`);
      try {
        const resp = await fetch(`${u}/models`, { signal: AbortSignal.timeout(15000) });
        return `declared ${u} (reachable ${resp.status})`;
      } catch {
        return `declared ${u} (not reachable from here)`;
      }
    })
  );

  // 16 prompt surfaces have no volatile literals
  results.push(
    await executeCheck(16, "prompt surfaces have no volatile literals", () => {
      const tool = join(harnessRoot, "tools", "prompt-lint.mjs");
      const r = runPromptLint(tool, userHome, ["scan", "--root", harnessRoot]);
      if (r.status !== 0) {
        throw new Error("volatile content in a prompt surface (breaks the provider cache prefix)");
      }
      return "clean";
    })
  );

  // 17 prompt surfaces match baseline (cache-prefix stable)
  results.push(
    await executeCheck(17, "prompt surfaces match baseline (cache-prefix stable)", () => {
      const baseline = join(harnessRoot, ".prompt-lint", "baseline.json");
      if (!existsSync(baseline)) {
        throw new NotConfiguredError("n/a (no baseline)");
      }
      const tool = join(harnessRoot, "tools", "prompt-lint.mjs");
      const r = runPromptLint(tool, userHome, ["check", "--root", harnessRoot]);
      if (r.status !== 0) {
        throw new Error("surfaces drifted - re-run prompt-lint baseline if the edit was intentional");
      }
      return "matches";
    })
  );

  // 18 prompt fingerprint is deterministic across runs
  results.push(
    await executeCheck(18, "prompt fingerprint is deterministic across runs", () => {
      const tool = join(harnessRoot, "tools", "prompt-lint.mjs");
      const r1 = runPromptLint(tool, userHome, ["fingerprint", "--root", harnessRoot]);
      if (r1.status !== 0) throw new Error("failed to compute first prompt fingerprint");
      const r2 = runPromptLint(tool, userHome, ["fingerprint", "--root", harnessRoot]);
      if (r2.status !== 0) throw new Error("failed to compute second prompt fingerprint");
      if (r1.stdout.trim() !== r2.stdout.trim()) {
        throw new Error("prompt fingerprint differs across consecutive runs");
      }
      return "deterministic";
    })
  );

  // 19 cache policy gates prompt lint and contract safety
  results.push(
    await executeCheck(19, "cache policy gates prompt lint and contract safety", () => {
      let fixture = join(harnessRoot, "tools", "tests", "fixtures", "return-contract", "valid.md");
      if (!existsSync(fixture)) {
        fixture = join(harnessRoot, "tools", "tests", "fixtures", "return-contract.fixture.md");
      }
      if (!existsSync(fixture)) {
        fixture = join(repoRoot, "tools", "tests", "fixtures", "return-contract", "valid.md");
      }
      if (!existsSync(fixture)) {
        fixture = join(repoRoot, "tools", "tests", "fixtures", "return-contract.fixture.md");
      }
      const tool = join(harnessRoot, "tools", "cache-policy.mjs");
      const args = [tool, "check", "--root", harnessRoot];
      if (existsSync(fixture)) {
        args.push("--return-contract", fixture);
      }
      const r = runProc(process.execPath, args);
      if (r.status !== 0) throw new Error("cache policy check failed safe gates");
      return "enforced";
    })
  );

  // 20 tier gate enforces artifacts (workflow.mjs)
  results.push(
    await executeCheck(20, "tier gate enforces artifacts (workflow.mjs)", () => {
      return testTierGate(harnessRoot, true);
    })
  );

  // 21 portable core specification and adapter presence
  results.push(
    await executeCheck(21, "portable core specification and adapter presence", () => {
      const portable = join(harnessRoot, "core", "PORTABLE.md");
      if (!existsSync(portable)) throw new Error("core/PORTABLE.md missing");
      const paseoSetup = join(harnessRoot, "paseo", "setup-paseo.ps1");
      if (!existsSync(paseoSetup)) throw new Error("paseo/setup-paseo.ps1 missing");
      return "core and paseo adapter present";
    })
  );

  // 22 codemap engine init/update cycle
  results.push(
    await executeCheck(22, "codemap engine init/update cycle", () => {
      const tmp = mkdtempSync(join(tmpdir(), "cm-"));
      mkdirSync(join(tmp, "src"), { recursive: true });
      writeFileSync(join(tmp, "src", "a.ts"), "export const a = 1;\n", "utf8");
      try {
        const cm = join(harnessRoot, "tools", "codemap.mjs");
        const i = runProc(process.execPath, [cm, "init", "--root", tmp, "--include", "src/**/*.ts"]);
        runProc(process.execPath, [cm, "update", "--root", tmp]);
        const c = runProc(process.execPath, [cm, "changes", "--root", tmp]);
        const iOut = (i.stdout || "") + (i.stderr || "");
        const cOut = (c.stdout || "") + (c.stderr || "");
        if (!/1 files tracked/.test(iOut)) {
          throw new Error(`init did not track the file: ${iOut.trim()}`);
        }
        if (!/\+0 ~0 -0/.test(cOut)) {
          throw new Error(`post-update changes not clean: ${cOut.trim()}`);
        }
        return "init/update/changes ok";
      } finally {
        try { rmSync(tmp, { recursive: true, force: true }); } catch {}
      }
    })
  );

  // 23 replay harness detects covered vs uncovered paths
  results.push(
    await executeCheck(23, "replay harness detects covered vs uncovered paths", () => {
      const tmp = mkdtempSync(join(tmpdir(), "rp-"));
      try {
        const cass = join(tmp, "c.json");
        writeFileSync(
          cass,
          '{"version":1,"recordedAt":"2026-01-01","target":"http://x","interactions":[{"key":"GET /known [-]","request":{"method":"GET","url":"/known"},"response":{"status":200,"body":"{}"}}]}',
          "utf8"
        );
        const leak = join(tmp, "leak.json");
        writeFileSync(
          leak,
          '{"version":1,"recordedAt":"2026-01-01","interactions":[{"key":"GET /a [-]","request":{"method":"GET","url":"/a"},"response":{"status":200,"body":"{\\"token\\":\\"sk-real-LEAKED1234567890\\"}"}}]}',
          "utf8"
        );
        const rp = join(harnessRoot, "tools", "replay.mjs");
        const ok = runProc(process.execPath, [rp, "verify", "--cassette", cass]);
        const bad = runProc(process.execPath, [rp, "verify", "--cassette", leak]);
        const okOut = (ok.stdout || "") + (ok.stderr || "");
        const badOut = (bad.stdout || "") + (bad.stderr || "");
        if (ok.status !== 0 || !/structurally valid/.test(okOut)) {
          throw new Error("valid cassette rejected");
        }
        if (bad.status === 0 || !/UNREDACTED/.test(badOut)) {
          throw new Error("leaked secret NOT caught");
        }
        return "both detected";
      } finally {
        try { rmSync(tmp, { recursive: true, force: true }); } catch {}
      }
    })
  );

  // 24 test-lens noise filter produces valid summary
  results.push(
    await executeCheck(24, "test-lens noise filter produces valid summary", () => {
      const dummy =
        '{"numTotalTests":2,"numPassedTests":1,"numFailedTests":1,"testResults":[{"name":"auth.test.ts","assertionResults":[{"title":"login","status":"failed","failureMessages":["Expected 200 got 401"]}]}]}';
      const tl = join(harnessRoot, "tools", "test-lens.mjs");
      const res = runProc(process.execPath, [tl, "parse"], { input: dummy });
      if (res.status !== 0) throw new Error(`test-lens failed with exit ${res.status}`);
      let parsed;
      try {
        parsed = JSON.parse(res.stdout);
      } catch (e) {
        throw new Error(`failed to parse test-lens output: ${e.message}`);
      }
      if (!parsed || parsed.total !== 2 || parsed.failed !== 1) {
        throw new Error(`test-lens parse failed: ${res.stdout}`);
      }
      return "summary ok";
    })
  );

  // 25 harness/repo drift (when a repo clone is present)
  results.push(
    await executeCheck(25, "harness/repo drift (when a repo clone is present)", () => {
      // Harness == repo is the documented in-place install (--root .): there is no
      // second tree to compare, and running sync against itself would report drift
      // because the repo ships prompt surfaces with the <HARNESS> placeholder.
      if (harnessRoot.toLowerCase() === repoRoot.toLowerCase()) {
        return "n/a (in-place install: harness is the repo)";
      }
      const res = checkSyncDrift(repoRoot, harnessRoot, userHome);
      if (!res.ok && res.error) throw new Error(res.error);
      return res.detail;
    })
  );

  // 26 auto-review CLI runs and respects problem gate
  results.push(
    await executeCheck(26, "auto-review CLI runs and respects problem gate", () => runAutoReviewFixtureCheck(harnessRoot))
  );

  // 27 debt ledger gate works
  results.push(
    await executeCheck(27, "debt ledger gate works", () => {
      const tool = join(harnessRoot, "tools", "debt-ledger.mjs");
      if (!existsSync(tool)) throw new Error("tools/debt-ledger.mjs not found");
      const tmp = mkdtempSync(join(tmpdir(), "dl-"));
      try {
        const testFile = join(tmp, "fixture.js");
        writeFileSync(testFile, "// defer: quick mock | ceiling: 5 items\n", "utf8");
        const resNoTrigger = runProc(process.execPath, [tool, "scan", "--root", tmp, "--check"]);
        if (resNoTrigger.status === 0) {
          throw new Error(
            `debt ledger gate unexpectedly succeeded on file without upgrade trigger: ${(resNoTrigger.stdout || "").trim()}`
          );
        }
        writeFileSync(
          testFile,
          "// defer: quick mock | ceiling: 5 items | upgrade: when items > 5\n",
          "utf8"
        );
        const resWithTrigger = runProc(process.execPath, [tool, "scan", "--root", tmp, "--check"]);
        if (resWithTrigger.status !== 0) {
          throw new Error(
            `debt ledger gate failed on valid file with upgrade trigger: ${(resWithTrigger.stdout || "").trim()}`
          );
        }
        const resJson = runProc(process.execPath, [tool, "scan", "--root", tmp, "--json"]);
        if (resJson.status !== 0) {
          throw new Error(
            `debt ledger scan --json failed with code ${resJson.status}: ${(resJson.stdout || "").trim()}`
          );
        }
        let parsed;
        try {
          parsed = JSON.parse(resJson.stdout);
        } catch (e) {
          throw new Error(`failed to parse debt ledger JSON output: ${e.message}`);
        }
        if (!parsed || parsed.total === undefined) {
          throw new Error(
            `parsed JSON missing expected fields: ${(resJson.stdout || "").trim()}`
          );
        }
        return "noTrigger=1 ok=0 json=ok";
      } finally {
        try { rmSync(tmp, { recursive: true, force: true }); } catch {}
      }
    })
  );

  // 28 CI template present and structurally sound
  // Named for what it does: this is a targeted structural lint, not a YAML parse — the
  // harness is zero-dependency, so there is no parser to call. It checks the anchors the
  // gate depends on AND the shape that makes them real (indentation, no tabs), which a
  // substring match alone would accept while the workflow is broken.
  results.push(
    await executeCheck(28, "CI template present and structurally sound", () => {
      let ciTemplate = join(harnessRoot, "templates", "ci", "workflow-gate.yml");
      if (!existsSync(ciTemplate)) {
        ciTemplate = join(repoRoot, "templates", "ci", "workflow-gate.yml");
      }
      if (!existsSync(ciTemplate)) throw new Error("templates/ci/workflow-gate.yml not found");
      const content = readFileSync(ciTemplate, "utf8");

      // A tab in YAML is invalid at any indentation level.
      const tabLine = content.split(/\r?\n/).findIndex((l) => /^\s*\t/.test(l));
      if (tabLine !== -1) throw new Error(`tab character at line ${tabLine + 1} - invalid YAML`);

      // Every `- name:` step must sit under `steps:` with consistent indentation.
      const lines = content.split(/\r?\n/);
      const stepIndents = lines
        .filter((l) => /^\s*- name:/.test(l))
        .map((l) => l.match(/^\s*/)[0].length);
      if (stepIndents.length === 0) throw new Error("no workflow steps found");
      if (new Set(stepIndents).size > 1) {
        throw new Error(`inconsistent step indentation: ${[...new Set(stepIndents)].join(", ")}`);
      }

      if (!/name:\s*Workflow Gate/.test(content)) throw new Error("missing name: Workflow Gate");
      if (!/on:\s*(?:\r?\n)\s+push:/.test(content)) throw new Error("missing push trigger");
      if (!/node-version:\s*20/.test(content)) throw new Error("missing node 20");
      if (!/auto-review\.mjs/.test(content)) throw new Error("missing auto-review invocation");
      if (!/actions\/github-script/.test(content)) throw new Error("missing PR comment action");
      return `${stepIndents.length} steps, structurally sound`;
    })
  );

  // 29 install doctor
  results.push(
    await executeCheck(29, "install doctor", () => {
      const { exists, res } = invokeDoctor(harnessRoot, agentDir, userHome);
      if (!exists) throw new Error("doctor.mjs missing");
      if (res.status !== 0) throw new Error(`doctor failed with code ${res.status}: ${(res.stdout || res.stderr || "").trim()}`);
      const json = JSON.parse(res.stdout || "{}");
      if (!json || Object.keys(json).length === 0) throw new Error("empty doctor JSON output");
      return json.mode ? `${json.mode} mode ok` : "doctor ok";
    })
  );

  return results;
}
