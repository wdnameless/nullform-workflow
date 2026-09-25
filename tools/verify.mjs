#!/usr/bin/env node
/**
 * tools/verify.mjs — Cross-platform verification and audit runner for the workflow harness.
 *
 * Runs verification gates across POSIX (Linux, macOS) and Windows.
 *
 * Usage:
 *   node tools/verify.mjs [--profile verify|audit] [--root <path>] [--harness <path>]
 *                         [--scope <list>] [--user-home <path>] [--json] [--help]
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
import { join, resolve, dirname, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export class NotConfiguredError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotConfiguredError";
  }
}

export function parseArgs(argv) {
  const opts = {
    profile: "verify",
    root: "",
    harness: "",
    scope: [],
    userHome: "",
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--profile") {
      opts.profile = argv[++i] || "verify";
    } else if (arg === "--root") {
      opts.root = argv[++i] || "";
    } else if (arg === "--harness" || arg === "--harness-root" || arg === "-HarnessRoot") {
      opts.harness = argv[++i] || "";
    } else if (arg === "--scope" || arg === "-Scope") {
      const val = argv[++i] || "";
      opts.scope = val.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg === "--user-home") {
      opts.userHome = argv[++i] || "";
    }
  }

  return opts;
}

export function resolveRoots(opts = {}) {
  const toolsDir = dirname(fileURLToPath(import.meta.url));
  const scriptParent = dirname(toolsDir);
  const parentOfScriptParent = dirname(scriptParent);

  let harnessRoot = opts.harness ? resolve(opts.harness) : "";
  if (!harnessRoot) {
    if (existsSync(join(parentOfScriptParent, "agent", "AGENTS.md"))) {
      harnessRoot = parentOfScriptParent;
    } else if (existsSync(join(scriptParent, "agent", "AGENTS.md"))) {
      harnessRoot = scriptParent;
    } else {
      let cur = scriptParent;
      while (cur) {
        if (existsSync(join(cur, "agent", "AGENTS.md"))) {
          harnessRoot = cur;
          break;
        }
        const up = dirname(cur);
        if (up === cur) break;
        cur = up;
      }
      if (!harnessRoot) harnessRoot = scriptParent;
    }
  }

  let repoRoot = opts.root ? resolve(opts.root) : "";
  if (!repoRoot) {
    const candidates = [
      scriptParent,
      join(harnessRoot, "workflow-repo"),
      join(dirname(harnessRoot), "workflow-repo"),
      harnessRoot,
    ];
    for (const cand of candidates) {
      if (
        cand &&
        existsSync(join(cand, "install.ps1")) &&
        existsSync(join(cand, "agent", "models.yml.example"))
      ) {
        repoRoot = cand;
        break;
      }
    }
    if (!repoRoot) {
      for (const cand of candidates) {
        if (cand && existsSync(join(cand, "install.ps1"))) {
          repoRoot = cand;
          break;
        }
      }
    }
    if (!repoRoot) repoRoot = harnessRoot;
  }

  const userHome = opts.userHome ? resolve(opts.userHome) : homedir();
  const agentDir = join(userHome, ".omp", "agent");

  return {
    harnessRoot: resolve(harnessRoot),
    repoRoot: resolve(repoRoot),
    userHome: resolve(userHome),
    agentDir: resolve(agentDir),
  };
}

export function runProc(cmd, args = [], options = {}) {
  const isWin = process.platform === "win32";
  return spawnSync(cmd, args, {
    encoding: "utf8",
    windowsHide: isWin,
    ...options,
  });
}

/**
 * prompt-lint also scans the agents home, so it must resolve the SAME home being
 * verified. Without this, checking a sandbox harness compares against the
 * operator's real ~/.agents baseline and reports drift that is not there.
 */
function runPromptLint(tool, userHome, args) {
  return runProc(process.execPath, [tool, ...args], {
    env: { ...process.env, HOME: userHome, USERPROFILE: userHome },
  });
}

export function runOmp(args = [], options = {}) {
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

export function runOpenspec(args = [], options = {}) {
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

export function readModelsYaml(agentDir) {
  const p = join(agentDir, "models.yml");
  if (!existsSync(p)) {
    throw new NotConfiguredError(
      "no provider yet - re-run install.ps1 with a base URL + key + model id"
    );
  }
  return readFileSync(p, "utf8");
}

export function checkSyncDrift(repoRoot, harnessRoot, userHome) {
  const isWin = process.platform === "win32";
  const syncScript = isWin
    ? join(repoRoot, "tools", "sync.ps1")
    : join(repoRoot, "tools", "sync.sh");

  if (!existsSync(syncScript)) {
    return { ok: true, detail: "n/a (no sync tool)" };
  }
  if (!existsSync(join(repoRoot, "install.ps1"))) {
    return { ok: true, detail: "n/a (standalone install)" };
  }

  // Pin the agents root to the user home being verified: without it the sync
  // scripts compare against the MACHINE's ~/.agents, so verifying a sandbox or a
  // second harness reports drift that belongs to an unrelated install.
  const agentsRoot = userHome ? join(userHome, ".agents") : "";
  const env = agentsRoot ? { ...process.env, AGENTS_ROOT: agentsRoot } : undefined;
  const envOpt = env ? { env } : {};

  let r;
  if (isWin) {
    r = runProc(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        syncScript,
        "-HarnessRoot",
        harnessRoot,
        ...(agentsRoot ? ["-AgentsRoot", agentsRoot] : []),
      ],
      envOpt
    );
  } else {
    r = runProc(syncScript, ["--harness-root", harnessRoot], envOpt);
  }
  const text = (r.stdout || "") + (r.stderr || "");
  if (/sync:\s*clean/.test(text)) {
    return { ok: true, detail: "clean" };
  }
  if (/Cannot locate workflow-repo/.test(text)) {
    return { ok: true, detail: "n/a (no repo clone)" };
  }
  return {
    ok: false,
    detail: `files drifted - run sync.${isWin ? "ps1" : "sh"} -Promote or -Deploy`,
    error: "agent defs/rules differ between harness and repo",
  };
}

export function checkSkillsDoctor(harnessRoot, userHome, repoRoot) {
  const tool = join(harnessRoot, "tools", "skills-doctor.mjs");
  return runProc(process.execPath, [
    tool,
    "--installed",
    join(userHome, ".agents", "skills"),
    "--repo",
    join(repoRoot, "skills"),
    "--agents-home",
    join(userHome, ".agents"),
  ]);
}

export function testTierGate(harnessRoot, strict = true) {
  const wf = join(harnessRoot, "tools", "workflow.mjs");
  if (!existsSync(wf)) {
    throw new Error(
      strict ? "workflow.mjs missing" : "workflow.mjs missing - the protocol is back to being prose"
    );
  }
  const tmp = mkdtempSync(join(tmpdir(), "wf-"));
  try {
    const env = { ...process.env, NF_NO_DASHBOARD: "1" };
    const s0 = runProc(process.execPath, [wf, "start", "--tier", "T0", "--task", "probe", "--root", tmp], { env });
    if (s0.status !== 0) throw new Error(`start T0 failed, got exit ${s0.status}`);
    const t0 = runProc(process.execPath, [wf, "check", "--root", tmp], { env });
    if (t0.status !== 0) throw new Error(`T0 should require no artifacts, got exit ${t0.status}`);

    const c0 = runProc(process.execPath, [wf, "close", "--root", tmp], { env });
    if (c0.status !== 0) throw new Error(`close T0 failed, got exit ${c0.status}`);

    const s2 = runProc(process.execPath, [wf, "start", "--tier", "T2", "--task", "probe2", "--root", tmp], { env });
    if (s2.status !== 0) throw new Error(`start T2 failed, got exit ${s2.status}`);
    const t2 = runProc(process.execPath, [wf, "check", "--root", tmp], { env });
    if (t2.status === 0) throw new Error("T2 passed with no artifacts - the gate does not work");

    if (strict) {
      const fake = runProc(process.execPath, [wf, "artifact", "--kind", "manifest", "--path", "nope/missing.md", "--root", tmp], { env });
      if (fake.status === 0) throw new Error("a non-existent artifact path was accepted");
      const close = runProc(process.execPath, [wf, "close", "--root", tmp], { env });
      if (close.status === 0) throw new Error("an incomplete tier was closed without --force");
      const forced = runProc(process.execPath, [wf, "close", "--force", "--reason", "probe", "--root", tmp], { env });
      if (forced.status !== 0) throw new Error("--force --reason should close");
      return "T0 passes, T2 blocks, fake paths rejected, forced close recorded";
    }
    return "T0 passes, T2 blocks";
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

export async function executeCheck(id, label, fn) {
  const start = Date.now();
  try {
    const res = await fn();
    const ms = Date.now() - start;
    let detail = "";
    let status = "PASS";
    if (typeof res === "string") {
      detail = res;
    } else if (typeof res === "boolean") {
      detail = res ? "True" : "False";
      status = res ? "PASS" : "FAIL";
    } else if (res && typeof res === "object") {
      status = res.ok === false ? "FAIL" : (res.status || "PASS");
      detail = res.detail ?? "";
    }
    return {
      id,
      label,
      status,
      detail,
      ms,
    };
  } catch (err) {
    const ms = Date.now() - start;
    if (err instanceof NotConfiguredError || err.name === "NotConfiguredError") {
      return {
        id,
        label,
        status: "SETUP",
        detail: err.message,
        ms,
      };
    }
    return {
      id,
      label,
      status: "FAIL",
      detail: err.message || String(err),
      ms,
    };
  }
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

  // 9 mcp.json parses, entries well-formed
  results.push(
    await executeCheck(9, "mcp.json parses, entries well-formed", () => {
      const p = join(agentDir, "mcp.json");
      if (!existsSync(p)) throw new Error("mcp.json missing");
      let m;
      try {
        m = JSON.parse(readFileSync(p, "utf8"));
      } catch (e) {
        throw new Error(`mcp.json parse error: ${e.message}`);
      }
      const servers = m.mcpServers || {};
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
      const p = join(agentDir, "mcp.json");
      // Absent config is "not configured", never "clean": returning true here claimed
      // nothing is unpinned in a file that does not exist.
      if (!existsSync(p)) throw new NotConfiguredError("mcp.json missing - no servers configured");
      const m = JSON.parse(readFileSync(p, "utf8"));
      const servers = m.mcpServers || {};
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
      const p = join(agentDir, "mcp.json");
      if (!existsSync(p)) throw new Error("mcp.json missing");
      const m = JSON.parse(readFileSync(p, "utf8"));
      const servers = m.mcpServers || {};
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
    await executeCheck(26, "auto-review CLI runs and respects problem gate", () => {
      const tmpClean = mkdtempSync(join(tmpdir(), "ar-clean-"));
      const tmpGate = mkdtempSync(join(tmpdir(), "ar-gate-"));
      try {
        writeFileSync(join(tmpGate, "fixture.js"), "// defer: test without upgrade\n", "utf8");
        const tool = join(harnessRoot, "tools", "auto-review.mjs");
        if (!existsSync(tool)) throw new Error("tools/auto-review.mjs not found");
        const resClean = runProc(process.execPath, [tool, "--root", tmpClean]);
        if (resClean.status !== 0) {
          throw new Error(`clean fixture failed: ${(resClean.stdout || "").trim()}`);
        }
        const resGate = runProc(process.execPath, [tool, "--root", tmpGate]);
        if (resGate.status === 0) {
          throw new Error("gate fixture unexpectedly succeeded");
        }
        return "clean=0 gate=1";
      } finally {
        try { rmSync(tmpClean, { recursive: true, force: true }); } catch {}
        try { rmSync(tmpGate, { recursive: true, force: true }); } catch {}
      }
    })
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

  // 29 install doctor (repo mode)
  results.push(
    await executeCheck(29, "install doctor (repo mode)", () => {
      const doc = join(harnessRoot, "tools", "doctor.mjs");
      if (!existsSync(doc)) throw new Error("doctor.mjs missing");
      const r = runProc(process.execPath, [doc, "--harness", harnessRoot, "--json"]);
      if (r.status !== 0) {
        throw new Error(`doctor failed with code ${r.status}: ${(r.stdout || r.stderr || "").trim()}`);
      }
      let json;
      try {
        json = JSON.parse(r.stdout);
      } catch (e) {
        throw new Error(`failed to parse doctor JSON output: ${e.message}`);
      }
      if (!json) throw new Error("empty doctor JSON output");
      return "repo mode ok";
    })
  );

  return results;
}

export async function runAuditProfile(ctx) {
  const { harnessRoot, repoRoot, userHome, scope } = ctx;
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
      const agentHarnessRoot = join(userHome, ".omp", "agent", ".harness-root");
      if (!existsSync(agentHarnessRoot)) {
        return { ok: true, detail: "n/a (no installed agent dir)" };
      }
      const doc = join(harnessRoot, "tools", "doctor.mjs");
      if (!existsSync(doc)) return { ok: false, detail: "doctor.mjs missing" };
      const r = runProc(process.execPath, [doc, "--harness", harnessRoot, "--json"]);
      if (r.status !== 0) {
        return { ok: false, detail: `doctor check failed with exit ${r.status}` };
      }
      try {
        const json = JSON.parse(r.stdout);
        if (json.ok) return { ok: true, detail: `clean (${json.summary?.pass} pass)` };
        return { ok: false, detail: `${json.summary?.fail} check(s) failed` };
      } catch (e) {
        return { ok: false, detail: `failed to parse doctor json output: ${e.message}` };
      }
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

export function formatVerifyTable(results) {
  const maxLabelLen = Math.max(63, ...results.map((r) => r.label.length));
  const col1W = maxLabelLen;
  const col2W = 6;

  let out = "";
  out += "Check".padEnd(col1W) + " " + "Result".padEnd(col2W) + " Detail\n";
  out += "-".repeat(col1W) + " " + "-".repeat(col2W) + " " + "------\n";
  for (const r of results) {
    const label = r.label.padEnd(col1W);
    const status = r.status.padEnd(col2W);
    out += `${label} ${status} ${r.detail}\n`;
  }
  return out;
}

export function formatAuditTable(results) {
  const col1W = 29;
  const col2W = 6;
  const col3W = 46;

  let out = "";
  out +=
    "Check".padEnd(col1W) +
    " " +
    "Result".padEnd(col2W) +
    " " +
    "Detail".padEnd(col3W) +
    " Ms\n";
  out += "-".repeat(col1W) + " " + "-".repeat(col2W) + " " + "-".repeat(col3W) + " --\n";
  for (const r of results) {
    const label = r.label.padEnd(col1W);
    const status = r.status.padEnd(col2W);
    const detail = (r.detail || "").padEnd(col3W);
    out += `${label} ${status} ${detail} ${r.ms ?? 0}\n`;
  }
  return out;
}

export async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);

  if (opts.help) {
    console.log(`Usage: node tools/verify.mjs [options]

Options:
  --profile verify|audit   Profile to run (default: verify)
  --root <path>            Project/repo root directory
  --harness <path>         Harness root directory
  --scope <list>           Scope for glossary/coverage check (e.g. agent,tools)
  --user-home <path>       Override user home directory
  --json                   Output results as JSON
  --help, -h               Show this help message
`);
    process.exit(0);
  }

  process.env.NF_NO_DASHBOARD = "1";

  let ctx;
  try {
    ctx = { ...resolveRoots(opts), scope: opts.scope };
  } catch (err) {
    console.error(`Failed to resolve roots: ${err.message}`);
    process.exit(2);
  }

  let results = [];
  if (opts.profile === "audit") {
    results = await runAuditProfile(ctx);
  } else if (opts.profile === "verify") {
    results = await runVerifyProfile(ctx);
  } else {
    console.error(`Unknown profile: ${opts.profile}. Supported: verify, audit.`);
    process.exit(2);
  }

  const failCount = results.filter((r) => r.status === "FAIL").length;
  const setupCount = results.filter((r) => r.status === "SETUP").length;
  const passCount = results.filter((r) => r.status === "PASS").length;
  const total = results.length;

  if (opts.json) {
    const output = {
      results,
      findings: results.filter((r) => r.status === "FAIL").map((r) => r.label),
      ok: failCount === 0,
      passed: passCount,
      total,
    };
    console.log(JSON.stringify(output, null, 2));
  } else if (opts.profile === "audit") {
    console.log("\n=== Harness audit ===\n");
    console.log(formatAuditTable(results));
    console.log("");
    if (failCount === 0) {
      console.log(`all ${total} checks clean\n`);
    } else {
      console.log(`${failCount} check(s) failed\n`);
    }
  } else {
    console.log("\n=== Workflow harness verification ===");
    console.log(`  harness : ${ctx.harnessRoot}`);
    console.log(`  agent   : ${ctx.agentDir}\n`);
    console.log(formatVerifyTable(results));
    console.log(`\n${total - failCount - setupCount}/${total} checks passed`);
    if (setupCount > 0) {
      console.log(`${setupCount} awaiting configuration - see the SETUP rows above.`);
    }
    console.log("");
  }

  process.exit(failCount > 0 ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(`Unhandled error: ${err.stack || err.message}`);
    process.exit(2);
  });
}
