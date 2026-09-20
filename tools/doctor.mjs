#!/usr/bin/env node
/**
 * tools/doctor.mjs — Проверка целостности окружения и установки harness.
 *
 * Использование:
 *   node tools/doctor.mjs [--harness <dir>] [--agent-dir <dir>] [--agents-home <dir>] [--json] [--quiet]
 *
 * Режимы:
 *   installed — когда <agent-dir>/.harness-root существует и указывает на текущий harness.
 *   repo — когда <agent-dir>/.harness-root отсутствует или указывает на другой путь.
 *          В режиме repo проверки agent-dir деградируют до статуса WARN с явным примечанием.
 *
 * Коды возврата:
 *   0 — ok (fail === 0, допустимы pass, warn, skip)
 *   1 — fail > 0
 *   2 — ошибка запуска / параметров
 */

import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const CORE_TOOLS = [
  "workflow.mjs",
  "prompt-lint.mjs",
  "skills-doctor.mjs",
  "glossary.mjs",
  "replay.mjs",
  "codemap.mjs",
  "return-contract.mjs",
  "cache-policy.mjs",
  "cache-doctor.mjs",
  "context-inbox.mjs",
  "domain-context.mjs",
  "oracle-model.mjs",
  "debt-ledger.mjs",
  "benchmark.mjs",
  "usage-audit.mjs",
  "auto-review.mjs",
  "doctor.mjs",
  "audit.ps1",
  "sync.ps1",
];

export function normalizePath(p) {
  if (!p) return "";
  return resolve(p).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
}
export function stripBom(text) {
  if (typeof text !== "string") return text;
  return text.replace(/^\uFEFF/, "");
}


export function parseCliArgs(args) {
  let harness = null;
  let agentDir = null;
  let agentsHome = null;
  let mode = null;
  let json = false;
  let quiet = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--harness") {
      harness = args[++i];
    } else if (arg === "--agent-dir") {
      agentDir = args[++i];
    } else if (arg === "--agents-home") {
      agentsHome = args[++i];
    } else if (arg === "--mode") {
      mode = args[++i];
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--quiet") {
      quiet = true;
    } else if (arg === "-h" || arg === "--help") {
      return { help: true };
    }
  }

  const defaultHarness = resolve(__dirname, "..");
  const home = homedir();
  const defaultAgentDir = join(home, ".omp", "agent");
  const defaultAgentsHome = join(home, ".agents");
  return {
    harness: harness ? resolve(harness) : defaultHarness,
    agentDir: agentDir ? resolve(agentDir) : defaultAgentDir,
    agentsHome: agentsHome ? resolve(agentsHome) : defaultAgentsHome,
    mode,
    json,
    quiet,
    help: false,
  };
}

export function runDoctor(options) {
  const { harness, agentDir, agentsHome, mode: requestedMode } = options;

  const harnessRootFile = join(agentDir, ".harness-root");
  let hasHarnessRoot = false;
  let harnessRootMatches = false;
  let harnessRootTarget = "";

  if (existsSync(harnessRootFile)) {
    hasHarnessRoot = true;
    try {
      harnessRootTarget = stripBom(readFileSync(harnessRootFile, "utf8")).trim();
      harnessRootMatches = normalizePath(harnessRootTarget) === normalizePath(harness);
    } catch {
      harnessRootMatches = false;
    }
  }

  const isInstalledDetected = hasHarnessRoot && harnessRootMatches;
  const mode = requestedMode || (isInstalledDetected ? "installed" : "repo");
  const checks = [];

  // 1. check 'node': version >= 18
  {
    const id = "node";
    const majorVersion = parseInt(process.versions.node.split(".")[0], 10);
    if (majorVersion >= 18) {
      checks.push({
        id,
        status: "pass",
        detail: `Node.js v${process.versions.node} (>= 18)`,
      });
    } else {
      checks.push({
        id,
        status: "fail",
        detail: `Node.js v${process.versions.node} устарел (требуется >= 18)`,
      });
    }
  }

  // 2. check 'harness-files'
  {
    const id = "harness-files";
    const missing = [];

    const agentsMd = join(harness, "agent", "AGENTS.md");
    if (!existsSync(agentsMd)) missing.push("agent/AGENTS.md");

    const agentsDir = join(harness, "agent", "agents");
    let roleCount = 0;
    if (existsSync(agentsDir)) {
      try {
        roleCount = readdirSync(agentsDir).filter((f) => f.endsWith(".md")).length;
      } catch {
        roleCount = 0;
      }
    }
    if (roleCount < 8) {
      missing.push(`agent/agents/*.md (найдено ${roleCount}, требуется >= 8)`);
    }

    const edFile = join(harness, "rules", "enterprise-directives.md");
    if (!existsSync(edFile)) missing.push("rules/enterprise-directives.md");

    const portableFile = join(harness, "core", "PORTABLE.md");
    if (!existsSync(portableFile)) missing.push("core/PORTABLE.md");

    const contextMd = join(harness, "CONTEXT.md");
    if (!existsSync(contextMd)) missing.push("CONTEXT.md");

    const readmeMd = join(harness, "README.md");
    if (!existsSync(readmeMd)) missing.push("README.md");

    const templatesDir = join(harness, "templates");
    if (!existsSync(templatesDir)) missing.push("templates/");

    const paseoDir = join(harness, "paseo");
    if (!existsSync(paseoDir)) missing.push("paseo/");

    if (missing.length === 0) {
      checks.push({
        id,
        status: "pass",
        detail: `Все обязательные файлы и директории харнесса присутствуют (${roleCount} ролей)`,
      });
    } else {
      checks.push({
        id,
        status: "fail",
        detail: `Отсутствуют обязательные файлы харнесса: ${missing.join(", ")}`,
      });
    }
  }

  // 3. check 'tools-syntax': core set present and node --check on all tools/*.mjs
  {
    const id = "tools-syntax";
    const toolsDir = join(harness, "tools");
    const missingCore = [];
    const syntaxErrors = [];

    for (const file of CORE_TOOLS) {
      const full = join(toolsDir, file);
      if (!existsSync(full)) {
        missingCore.push(file);
      }
    }

    if (existsSync(toolsDir)) {
      let mjsFiles = [];
      try {
        mjsFiles = readdirSync(toolsDir).filter((f) => f.endsWith(".mjs"));
      } catch {
        mjsFiles = [];
      }

      for (const mjs of mjsFiles) {
        const fullPath = join(toolsDir, mjs);
        const res = spawnSync(process.execPath, ["--check", fullPath], {
          encoding: "utf8",
        });
        if (res.status !== 0) {
          syntaxErrors.push(mjs);
        }
      }
    } else {
      missingCore.push("tools/ directory missing");
    }

    if (missingCore.length > 0 || syntaxErrors.length > 0) {
      const details = [];
      if (missingCore.length > 0) {
        details.push(`отсутствуют обязательные инструменты: ${missingCore.join(", ")}`);
      }
      if (syntaxErrors.length > 0) {
        details.push(`синтаксические ошибки в: ${syntaxErrors.join(", ")}`);
      }
      checks.push({
        id,
        status: "fail",
        detail: details.join("; "),
      });
    } else {
      checks.push({
        id,
        status: "pass",
        detail: `Все инструменты ядра присутствуют, синтаксис проверен (node --check)`,
      });
    }
  }

  // 4. check 'tools-smoke': prompt-lint fingerprint, debt-ledger scan
  {
    const id = "tools-smoke";
    const promptLintPath = join(harness, "tools", "prompt-lint.mjs");
    const debtLedgerPath = join(harness, "tools", "debt-ledger.mjs");
    const smokeErrors = [];

    if (existsSync(promptLintPath)) {
      const pLintRes = spawnSync(
        process.execPath,
        [promptLintPath, "fingerprint", "--root", harness],
        { encoding: "utf8" }
      );
      if (pLintRes.status !== 0) {
        smokeErrors.push(`prompt-lint fingerprint завершился с кодом ${pLintRes.status}`);
      }
    } else {
      smokeErrors.push("prompt-lint.mjs не найден для smoke-теста");
    }

    if (existsSync(debtLedgerPath)) {
      const tmpTestDir = mkdtempSync(join(tmpdir(), "doctor-smoke-"));
      try {
        const dLedgerRes = spawnSync(
          process.execPath,
          [debtLedgerPath, "scan", "--root", tmpTestDir],
          { encoding: "utf8" }
        );
        if (dLedgerRes.status !== 0) {
          smokeErrors.push(`debt-ledger scan завершился с кодом ${dLedgerRes.status}`);
        }
      } catch (err) {
        smokeErrors.push(`debt-ledger scan упал: ${err.message}`);
      } finally {
        try {
          rmSync(tmpTestDir, { recursive: true, force: true });
        } catch {}
      }
    } else {
      smokeErrors.push("debt-ledger.mjs не найден для smoke-теста");
    }

    if (smokeErrors.length > 0) {
      checks.push({
        id,
        status: "fail",
        detail: smokeErrors.join("; "),
      });
    } else {
      checks.push({
        id,
        status: "pass",
        detail: "Smoke-тесты пройдены: prompt-lint fingerprint и debt-ledger scan успешны",
      });
    }
  }

  // 5. check 'agent-wiring'
  {
    const id = "agent-wiring";
    if (mode === "repo") {
      const note = !hasHarnessRoot
        ? "Режим repo: агентская директория не настроена (.harness-root отсутствует)"
        : `Режим repo: агентская директория привязана к другому харнессу (${harnessRootTarget})`;
      checks.push({
        id,
        status: "warn",
        detail: note,
      });
    } else {
      const wiringErrors = [];
      const agentsMd = join(agentDir, "AGENTS.md");
      if (!existsSync(agentsMd)) {
        wiringErrors.push(`${agentDir}/AGENTS.md отсутствует`);
      } else {
        try {
          const agentsText = stripBom(readFileSync(agentsMd, "utf8"));
          const normHarness = normalizePath(harness);
          const containsHarness =
            agentsText.includes(harness) ||
            agentsText.toLowerCase().includes(normHarness) ||
            agentsText.replace(/\\/g, "/").toLowerCase().includes(normHarness);
          if (!containsHarness) {
            wiringErrors.push(`${agentDir}/AGENTS.md не содержит путь к харнессу`);
          }
        } catch (e) {
          wiringErrors.push(`ошибка чтения ${agentDir}/AGENTS.md: ${e.message}`);
        }
      }

      if (!harnessRootMatches) {
        wiringErrors.push(`.harness-root (${harnessRootTarget}) не совпадает с харнессом (${harness})`);
      }

      const agentsSub = join(agentDir, "agents");
      let roleCount = 0;
      if (existsSync(agentsSub)) {
        try {
          roleCount = readdirSync(agentsSub).filter((f) => f.endsWith(".md")).length;
        } catch {
          roleCount = 0;
        }
      }
      if (roleCount < 8) {
        wiringErrors.push(`${agentDir}/agents содержит ${roleCount} файлов (требуется >= 8)`);
      }

      const agentEd = join(agentDir, "rules", "enterprise-directives.md");
      if (!existsSync(agentEd)) {
        wiringErrors.push(`${agentDir}/rules/enterprise-directives.md отсутствует`);
      }

      const homeEd = join(agentsHome, "rules", "enterprise-directives.md");
      if (!existsSync(homeEd)) {
        wiringErrors.push(`${agentsHome}/rules/enterprise-directives.md отсутствует`);
      }

      if (wiringErrors.length > 0) {
        checks.push({
          id,
          status: "fail",
          detail: wiringErrors.join("; "),
        });
      } else {
        checks.push({
          id,
          status: "pass",
          detail: `Проводка агента корректна (${roleCount} ролей, правила и AGENTS.md проверены)`,
        });
      }
    }
  }

  // 6. check 'skills' (spawn skills-doctor.mjs)
  {
    const id = "skills";
    const skillsDoctorPath = join(harness, "tools", "skills-doctor.mjs");
    const installedSkills = join(agentsHome, "skills");
    const candidateRepoSkills = [
      join(harness, "workflow-repo", "skills"),
      join(harness, "skills"),
    ];
    const repoSkills = candidateRepoSkills.find((p) => existsSync(p)) || join(harness, "skills");

    if (!existsSync(skillsDoctorPath)) {
      checks.push({
        id,
        status: "fail",
        detail: "tools/skills-doctor.mjs не найден",
      });
    } else if (!existsSync(installedSkills)) {
      if (mode === "repo") {
        checks.push({
          id,
          status: "warn",
          detail: `Режим repo: установленная папка навыков не найдена (${installedSkills})`,
        });
      } else {
        checks.push({
          id,
          status: "fail",
          detail: `Установленная папка навыков не найдена (${installedSkills})`,
        });
      }
    } else {
      const res = spawnSync(
        process.execPath,
        [skillsDoctorPath, "--installed", installedSkills, "--repo", repoSkills],
        { encoding: "utf8" }
      );
      const out = (res.stdout || "") + (res.stderr || "");
      const match = /(\d+)\s+installed,\s+(\d+)\s+in repo/i.exec(out);
      const countsNote = match ? ` (${match[1]} установлено, ${match[2]} в репозитории)` : "";

      if (res.status === 0) {
        checks.push({
          id,
          status: "pass",
          detail: `Все проверки навыков пройдены${countsNote}`,
        });
      } else {
        // Parse individual problem lines: format from skills-doctor:
        //   <skill_name>  <kind>  <detail>
        // e.g. "    banner-design                parity  installed copy differs from repo..."
        const lines = out.split("\n");
        const parsedProblems = [];
        const problemRegex = /^\s{2,}(\S+)\s+(parity|truncation|frontmatter|orphan|duplicate-name|encoding)\s+(.*)$/;
        for (const line of lines) {
          const pMatch = problemRegex.exec(line);
          if (pMatch) {
            parsedProblems.push({
              skill: pMatch[1],
              kind: pMatch[2],
              detail: pMatch[3].trim(),
            });
          }
        }

        if (parsedProblems.length === 0) {
          // No structured problems parsed -> fail with tail of output
          const tail = out.trim().split("\n").slice(-3).join(" ").trim() || `код ${res.status}`;
          checks.push({
            id,
            status: "fail",
            detail: `skills-doctor завершился с кодом ${res.status}${countsNote}: ${tail}`,
          });
        } else {
          const parityProblems = parsedProblems.filter((p) => p.kind === "parity");
          const failProblems = parsedProblems.filter((p) => p.kind !== "parity");

          if (failProblems.length > 0) {
            const failSummary = failProblems.map((p) => `${p.skill} (${p.kind}: ${p.detail})`).join("; ");
            checks.push({
              id,
              status: "fail",
              detail: `Обнаружены дефекты навыков${countsNote}: ${failSummary}`,
            });
          } else {
            // Only parity issues exist -> WARN
            checks.push({
              id,
              status: "warn",
              detail: `${parityProblems.length} parity (marketplace-managed drift is expected)${countsNote}`,
            });
          }
        }
      }
    }
  }

  // 7. check 'prompt-baseline': .prompt-lint/baseline.json exists AND prompt-lint check --root <harness> exit 0
  {
    const id = "prompt-baseline";
    const baselineFile = join(harness, ".prompt-lint", "baseline.json");
    if (!existsSync(baselineFile)) {
      checks.push({
        id,
        status: "warn",
        detail: "Файл .prompt-lint/baseline.json отсутствует (рекомендуется создать через baseline)",
      });
    } else {
      const promptLintPath = join(harness, "tools", "prompt-lint.mjs");
      if (!existsSync(promptLintPath)) {
        checks.push({
          id,
          status: "fail",
          detail: "tools/prompt-lint.mjs не найден для проверки baseline",
        });
      } else {
        const res = spawnSync(
          process.execPath,
          [promptLintPath, "check", "--root", harness],
          { encoding: "utf8" }
        );
        if (res.status === 0) {
          checks.push({
            id,
            status: "pass",
            detail: "Бейзлайн промптов актуален (дрейф не обнаружен)",
          });
        } else {
          // Check if baseline drift occurred
          checks.push({
            id,
            status: "warn",
            detail: `Обнаружен дрейф поверхностей промптов от бейзлайна (код ${res.status})`,
          });
        }
      }
    }
  }

  // 8. check 'configs': if mcp.json/models.yml/config.yml exist in agent-dir: mcp.json parse; NEVER print values
  {
    const id = "configs";
    const reported = [];
    let configError = null;

    const mcpJson = join(agentDir, "mcp.json");
    if (existsSync(mcpJson)) {
      try {
        const content = stripBom(readFileSync(mcpJson, "utf8"));
        JSON.parse(content);
        reported.push("mcp.json (валидный JSON)");
      } catch (err) {
        configError = `mcp.json не является валидным JSON: ${err.message}`;
      }
    }

    const modelsYml = join(agentDir, "models.yml");
    if (existsSync(modelsYml)) {
      reported.push("models.yml (присутствует)");
    }

    const configYml = join(agentDir, "config.yml");
    if (existsSync(configYml)) {
      reported.push("config.yml (присутствует)");
    }

    if (configError) {
      checks.push({
        id,
        status: "fail",
        detail: configError,
      });
    } else if (reported.length > 0) {
      checks.push({
        id,
        status: "pass",
        detail: `Конфигурационные файлы: ${reported.join(", ")}`,
      });
    } else {
      checks.push({
        id,
        status: "pass",
        detail: "Конфигурационные файлы в agent-dir отсутствуют (не настроены)",
      });
    }
  }

  // Summary calculation
  const summary = {
    pass: checks.filter((c) => c.status === "pass").length,
    fail: checks.filter((c) => c.status === "fail").length,
    warn: checks.filter((c) => c.status === "warn").length,
    skip: checks.filter((c) => c.status === "skip").length,
  };

  const ok = summary.fail === 0;

  return {
    mode,
    harness,
    agentDir,
    checks,
    summary,
    ok,
  };
}

export function printHumanReport(result, quiet) {
  const { mode, harness, agentDir, checks, summary, ok } = result;

  if (!quiet) {
    console.log(`\ndoctor: режим=${mode} харнесс=${harness}\nагентская директория=${agentDir}\n`);
    for (const c of checks) {
      const tag = c.status.toUpperCase().padEnd(4);
      let symbol = "•";
      if (c.status === "pass") symbol = "✓";
      else if (c.status === "fail") symbol = "✗";
      else if (c.status === "warn") symbol = "⚠";
      else if (c.status === "skip") symbol = "-";

      console.log(`  ${symbol} [${tag}] ${c.id.padEnd(16)} : ${c.detail}`);
    }
    console.log("");
  }

  const summaryStr = `Итог: pass=${summary.pass} fail=${summary.fail} warn=${summary.warn} skip=${summary.skip} -> ${ok ? "OK" : "FAIL"}`;
  console.log(summaryStr);
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseCliArgs(argv);
  if (opts.help) {
    console.log(`Использование: node tools/doctor.mjs [--harness <dir>] [--agent-dir <dir>] [--agents-home <dir>] [--json] [--quiet]`);
    process.exit(0);
  }

  const result = runDoctor(opts);

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHumanReport(result, opts.quiet);
  }

  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
