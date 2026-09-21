import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  findJsonlFiles,
  loadMcpServers,
  loadInstalledSkills,
  loadPlugins,
  KNOWN_PLUGIN_TOOLS,
  auditUsage,
  formatAuditReport,
} from "../usage-audit.mjs";

test("usage-audit: finds jsonl files recursively and loads mcp and skills", () => {
  const tmp = mkdtempSync(join(tmpdir(), "audit-test-basic-"));
  try {
    const sub1 = join(tmp, "sessions", "sub1");
    const sub2 = join(tmp, "sessions", "sub2");
    mkdirSync(sub1, { recursive: true });
    mkdirSync(sub2, { recursive: true });

    writeFileSync(join(sub1, "a.jsonl"), "");
    writeFileSync(join(sub2, "b.jsonl"), "");
    writeFileSync(join(sub2, "c.txt"), "");

    const found = findJsonlFiles(join(tmp, "sessions"));
    assert.equal(found.length, 2);

    const mcpPath = join(tmp, "mcp.json");
    writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          server1: { command: "cmd" },
          server2: { command: "cmd" },
        },
      })
    );
    const mcpServers = loadMcpServers(mcpPath);
    assert.deepEqual(mcpServers, ["server1", "server2"]);

    const skillsDir = join(tmp, "skills");
    mkdirSync(join(skillsDir, "skill-a"), { recursive: true });
    writeFileSync(join(skillsDir, "skill-a", "SKILL.md"), "# Skill A");
    mkdirSync(join(skillsDir, "skill-b"), { recursive: true });
    writeFileSync(join(skillsDir, "skill-b", "skill.md"), "# Skill B");
    mkdirSync(join(skillsDir, "skill-c"), { recursive: true });

    const skills = loadInstalledSkills(skillsDir);
    assert.deepEqual(skills, ["skill-a", "skill-b", "skill-c"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("usage-audit: parses jsonl fixtures with malformed lines, counts tools/skills and finds unused", () => {
  const tmp = mkdtempSync(join(tmpdir(), "audit-test-fixture-"));
  try {
    const sessionsDir = join(tmp, "sessions");
    const sub1 = join(sessionsDir, "project1");
    const sub2 = join(sessionsDir, "project2");
    mkdirSync(sub1, { recursive: true });
    mkdirSync(sub2, { recursive: true });

    // Файл 1: обычные вызовы встроенных тулов и skill://
    const linesFile1 = [
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", name: "read", arguments: { path: "skill://alpha/guide" } },
            { type: "toolCall", name: "bash", arguments: { command: "dir" } },
          ],
        },
      }),
      // Битая строка
      "THIS IS NOT VALID JSON {[[",
      // Еще один вызов
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", name: "read", arguments: { path: "src/index.js" } },
            { type: "toolCall", name: "grep", arguments: { pattern: "test" } },
          ],
        },
      }),
    ];
    writeFileSync(join(sub1, "session1.jsonl"), linesFile1.join("\n"));

    // Файл 2: MCP вызовы (xd://mcp__server1_func и прямой mcp__server1_action)
    const linesFile2 = [
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "write",
              arguments: { path: "xd://mcp__server1_run", content: "{}" },
            },
            {
              type: "toolCall",
              name: "mcp__server1_status",
              arguments: {},
            },
          ],
        },
      }),
      // Пустая строка
      "",
    ];
    writeFileSync(join(sub2, "session2.jsonl"), linesFile2.join("\n"));

    // mcp.json содержит server1 (использовался) и server2 (не использовался)
    const mcpPath = join(tmp, "mcp.json");
    writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          server1: { command: "cmd" },
          server2: { command: "cmd" },
        },
      })
    );

    // skills содержит alpha (использовался) и beta (не использовался)
    const skillsDir = join(tmp, "skills");
    mkdirSync(join(skillsDir, "alpha"), { recursive: true });
    writeFileSync(join(skillsDir, "alpha", "SKILL.md"), "Alpha");
    mkdirSync(join(skillsDir, "beta"), { recursive: true });
    writeFileSync(join(skillsDir, "beta", "SKILL.md"), "Beta");

    const res = auditUsage({
      sessionsDir,
      days: 30,
      mcpPath,
      skillsDir,
      now: Date.now(),
    });

    assert.equal(res.empty, false);
    assert.equal(res.stats.totalFiles, 2);
    assert.equal(res.stats.scannedFiles, 2);
    assert.equal(res.stats.totalLines, 4); // 3 non-empty in file 1, 1 in file 2
    assert.equal(res.stats.malformedLines, 1);

    // Встроенные тулы: read: 2, bash: 1, grep: 1
    assert.equal(res.tools.builtins.read, 2);
    assert.equal(res.tools.builtins.bash, 1);
    assert.equal(res.tools.builtins.grep, 1);

    // MCP тулы: mcp__server1_run: 1, mcp__server1_status: 1
    assert.equal(res.tools.mcp["mcp__server1_run"], 1);
    assert.equal(res.tools.mcp["mcp__server1_status"], 1);

    // Скиллы: alpha: 1
    assert.equal(res.tools.skills["alpha"], 1);

    // Неиспользуемые:
    // server2 не использовался
    assert.deepEqual(res.unusedMcp, ["server2"]);
    // beta не использовался
    assert.deepEqual(res.unusedSkills, ["beta"]);

    // Проверка текстового отчёта
    const reportText = formatAuditReport(res);
    assert.match(reportText, /=== АУДИТ ИСПОЛЬЗОВАНИЯ ТУЛОВ И СКИЛЛОВ ===/);
    assert.match(reportText, /Битых строк JSON: 1/);
    assert.match(reportText, /server2/);
    assert.match(reportText, /beta/);
    assert.match(reportText, /alpha/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("usage-audit: handles missing sessions directory gracefully", () => {
  const missingDir = join(tmpdir(), "non-existent-sessions-" + Date.now());
  const res = auditUsage({
    sessionsDir: missingDir,
    days: 30,
  });

  assert.equal(res.empty, true);
  assert.equal(res.reason, "Сессий не найдено");

  const reportText = formatAuditReport(res);
  assert.match(reportText, /Сессий не найдено/);
});

test("usage-audit: CLI execution produces valid text and JSON output", () => {
  const tmp = mkdtempSync(join(tmpdir(), "audit-cli-fixture-"));
  try {
    const sessionsDir = join(tmp, "sessions");
    mkdirSync(sessionsDir, { recursive: true });

    const line = JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", name: "read", arguments: { path: "skill://foo" } },
        ],
      },
    });
    writeFileSync(join(sessionsDir, "test.jsonl"), line + "\n");

    const mcpPath = join(tmp, "mcp.json");
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: { unusedSrv: {} } }));

    const skillsDir = join(tmp, "skills");
    mkdirSync(join(skillsDir, "foo"), { recursive: true });
    mkdirSync(join(skillsDir, "bar"), { recursive: true });

    const auditScript = join(process.cwd(), "tools", "usage-audit.mjs");

    // Запуск в текстовом режиме
    const textOut = execFileSync(
      process.execPath,
      [
        auditScript,
        "--sessions",
        sessionsDir,
        "--days",
        "999",
        "--mcp",
        mcpPath,
        "--skills",
        skillsDir,
      ],
      { encoding: "utf8" }
    );
    assert.match(textOut, /=== АУДИТ ИСПОЛЬЗОВАНИЯ ТУЛОВ И СКИЛЛОВ ===/);
    assert.match(textOut, /foo/);
    assert.match(textOut, /unusedSrv/);
    assert.match(textOut, /bar/);

    // Запуск в JSON режиме
    const jsonOut = execFileSync(
      process.execPath,
      [
        auditScript,
        "--sessions",
        sessionsDir,
        "--days",
        "999",
        "--mcp",
        mcpPath,
        "--skills",
        skillsDir,
        "--json",
      ],
      { encoding: "utf8" }
    );
    const parsed = JSON.parse(jsonOut);
    assert.equal(parsed.empty, false);
    assert.equal(parsed.stats.totalFiles, 1);
    assert.deepEqual(parsed.unusedMcp, ["unusedSrv"]);
    assert.deepEqual(parsed.unusedSkills, ["bar"]);
    assert.equal(parsed.tools.skills.foo, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

/* ------------------------------------------------- adversarial (hardening-2) */

const CLI = join(process.cwd(), 'tools', 'usage-audit.mjs');

/** Запуск CLI с произвольными аргументами. */
function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

test('usage-audit CLI: неверные --days/--top/опечатки отклоняются, а не подменяются молча', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'audit-bad-args-'));
  try {
    const sessions = join(tmp, 'sessions');
    mkdirSync(sessions, { recursive: true });

    const bad = [
      [['--days', '0'], /--days/],
      [['--days', '-5'], /--days/],
      [['--days', 'abc'], /--days/],
      [['--days'], /--days/],
      [['--top', '0'], /--top/],
      [['--top'], /--top/],
      [['--day', '30'], /неизвестный параметр --day/],
      [['--sessions'], /--sessions/],
    ];
    for (const [args, re] of bad) {
      const cli = runCli(['--sessions', sessions, ...args]);
      assert.equal(cli.status, 2, JSON.stringify(args));
      assert.equal(cli.stdout.trim(), '', JSON.stringify(args));
      assert.match(cli.stderr, re, JSON.stringify(args));
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('usage-audit CLI: --top ограничивает текстовые списки и не молчит об усечении', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'audit-top-'));
  try {
    const sessions = join(tmp, 'sessions');
    mkdirSync(sessions, { recursive: true });
    const lines = ['read', 'write', 'edit', 'grep'].map((name) =>
      JSON.stringify({ type: 'toolCall', name, input: {} })
    );
    writeFileSync(join(sessions, 's.jsonl'), lines.join('\n') + '\n');

    const cli = runCli(['--sessions', sessions, '--days', '30', '--top', '2']);
    assert.equal(cli.status, 0);
    assert.match(cli.stdout, /ограничение --top 2/);
    const shown = cli.stdout.split('\n').filter((l) => /^  (read|write|edit|grep) /.test(l));
    assert.equal(shown.length, 2);

    // JSON отдаёт полные счётчики независимо от --top
    const jsonCli = runCli(['--sessions', sessions, '--days', '30', '--top', '2', '--json']);
    assert.equal(jsonCli.status, 0);
    const data = JSON.parse(jsonCli.stdout);
    assert.equal(Object.keys(data.tools.builtins).length, 4);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('usage-audit: битый mcp.json не выглядит как «конфиг пуст»', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'audit-bad-mcp-'));
  try {
    const sessions = join(tmp, 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 's.jsonl'), JSON.stringify({ type: 'toolCall', name: 'read', input: {} }) + '\n');

    const mcpPath = join(tmp, 'mcp.json');
    writeFileSync(mcpPath, '{broken', 'utf8');

    const res = auditUsage({ sessionsDir: sessions, days: 30, mcpPath, skillsDir: join(tmp, 'nope') });
    assert.equal(res.unusedMcp.length, 0);
    assert.match(res.notes.join('\n'), /mcp\.json не читается/);
    assert.match(formatAuditReport(res), /mcp\.json не читается/);

    const cli = runCli(['--sessions', sessions, '--days', '30', '--mcp', mcpPath]);
    assert.equal(cli.status, 0);
    assert.match(cli.stdout, /mcp\.json не читается/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadPlugins: parses various formats and strips version suffixes", () => {
  const tmp = mkdtempSync(join(tmpdir(), "audit-load-plugins-"));
  try {
    // 1) agent/plugins.json format (array and { plugins: [...] })
    const arrPath = join(tmp, "plugins-arr.json");
    writeFileSync(
      arrPath,
      JSON.stringify([
        { name: "pi-lens@^4.2.1", spec: "pi-lens@^4.2.1" },
        { name: "@dietrichgebert/ponytail@1.0.0", spec: "..." },
      ])
    );
    assert.deepEqual(loadPlugins(arrPath), ["@dietrichgebert/ponytail", "pi-lens"]);

    const objPath = join(tmp, "plugins-obj.json");
    writeFileSync(
      objPath,
      JSON.stringify({
        plugins: [
          { name: "pi-qq" },
          { name: "pi-goal-x@0.31.6" },
        ],
      })
    );
    assert.deepEqual(loadPlugins(objPath), ["pi-goal-x", "pi-qq"]);

    // 2) omp plugin list --json format ({ npm: [{ name, enabled }] })
    const npmPath = join(tmp, "plugins-npm.json");
    writeFileSync(
      npmPath,
      JSON.stringify({
        npm: [
          { name: "oh-my-pi-plugin-morph", enabled: true },
          { name: "pi-bar", enabled: false },
        ],
      })
    );
    assert.deepEqual(loadPlugins(npmPath), ["oh-my-pi-plugin-morph", "pi-bar"]);

    // 3) package.json format ({ dependencies: { ... } })
    const pkgPath = join(tmp, "package.json");
    writeFileSync(
      pkgPath,
      JSON.stringify({
        dependencies: {
          "pi-linter": "^0.2.7",
          "omp-url-pin": "~1.2.0",
        },
      })
    );
    assert.deepEqual(loadPlugins(pkgPath), ["omp-url-pin", "pi-linter"]);

    // 4) edge cases: missing file, broken JSON, invalid format
    assert.deepEqual(loadPlugins(join(tmp, "non-existent.json")), []);

    const brokenPath = join(tmp, "broken.json");
    writeFileSync(brokenPath, "{ invalid json");
    const notesBroken = [];
    assert.deepEqual(loadPlugins(brokenPath, notesBroken), []);
    assert.match(notesBroken[0], /не читается/);

    const unknownPath = join(tmp, "unknown.json");
    writeFileSync(unknownPath, JSON.stringify({ otherField: 123 }));
    const notesUnknown = [];
    assert.deepEqual(loadPlugins(unknownPath, notesUnknown), []);
    assert.match(notesUnknown[0], /неизвестный формат/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("KNOWN_PLUGIN_TOOLS: exports mapping for 14 plugins", () => {
  const expectedPlugins = [
    "oh-my-pi-plugin-morph",
    "pi-lens",
    "pi-goal-x",
    "pi-qq",
    "pi-prompt-shelf",
    "pi-bar",
    "pi-gh-cli",
    "@dietrichgebert/ponytail",
    "omp-plugin-duplicate-detector",
    "omp-typescript-complexity-evaluator",
    "omp-url-pin",
    "@plannotator/pi-extension",
    "pi-linter",
    "oh-my-pi-plugin-grok-build",
  ];
  for (const name of expectedPlugins) {
    assert.ok(Array.isArray(KNOWN_PLUGIN_TOOLS[name]), `missing plugin tools for ${name}`);
    assert.ok(KNOWN_PLUGIN_TOOLS[name].length > 0, `empty tools for ${name}`);
  }
});

test("usage-audit: counts plugin tool calls and slash commands, identifies unused plugins", () => {
  const tmp = mkdtempSync(join(tmpdir(), "audit-plugins-usage-"));
  try {
    const sessionsDir = join(tmp, "sessions");
    mkdirSync(sessionsDir, { recursive: true });

    // Session 1:
    // - toolCall: fast_edit (oh-my-pi-plugin-morph)
    // - toolCall write with xd://fastcompact (oh-my-pi-plugin-morph)
    // - user message with slash command: /lens (pi-lens)
    // - user message with slash command: /qq (pi-qq)
    // - user message with slash command: /shelf (pi-prompt-shelf)
    const session1 = [
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: "/lens status\n/qq why did the test fail?",
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Applying fast_edit to patch the file" },
            { type: "toolCall", name: "fast_edit", arguments: { path: "src/app.ts" } },
            { type: "toolCall", name: "write", arguments: { path: "xd://fastcompact", content: "{}" } },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "/shelf list" }],
        },
      }),
    ];
    writeFileSync(join(sessionsDir, "session1.jsonl"), session1.join("\n"));

    // Session 2:
    // - toolCall: goal_create (pi-goal-x)
    // - toolCall: duplicate-detector (omp-plugin-duplicate-detector)
    // - slash command: /bar (pi-bar)
    const session2 = [
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", name: "goal_create", arguments: { title: "Fix bug" } },
            { type: "toolCall", name: "duplicate-detector", arguments: {} },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: "/bar",
        },
      }),
    ];
    writeFileSync(join(sessionsDir, "session2.jsonl"), session2.join("\n"));

    // plugins.json: configured plugins
    const pluginsPath = join(tmp, "plugins.json");
    writeFileSync(
      pluginsPath,
      JSON.stringify({
        plugins: [
          { name: "oh-my-pi-plugin-morph" },
          { name: "pi-lens" },
          { name: "pi-qq" },
          { name: "pi-prompt-shelf" },
          { name: "pi-goal-x" },
          { name: "pi-bar" },
          { name: "omp-plugin-duplicate-detector" },
          { name: "@dietrichgebert/ponytail" },
          { name: "pi-linter" },
          { name: "omp-url-pin" },
        ],
      })
    );

    const res = auditUsage({
      sessionsDir,
      days: 30,
      pluginsPath,
      now: Date.now(),
    });

    assert.equal(res.empty, false);
    // Verifying plugin calls
    assert.equal(res.pluginStats["oh-my-pi-plugin-morph"].calls, 2);
    assert.equal(res.pluginStats["oh-my-pi-plugin-morph"].used, true);

    assert.equal(res.pluginStats["pi-lens"].calls, 1);
    assert.equal(res.pluginStats["pi-lens"].used, true);

    assert.equal(res.pluginStats["pi-qq"].calls, 1);
    assert.equal(res.pluginStats["pi-qq"].used, true);

    assert.equal(res.pluginStats["pi-prompt-shelf"].calls, 1);
    assert.equal(res.pluginStats["pi-prompt-shelf"].used, true);

    assert.equal(res.pluginStats["pi-goal-x"].calls, 1);
    assert.equal(res.pluginStats["pi-goal-x"].used, true);

    assert.equal(res.pluginStats["pi-bar"].calls, 1);
    assert.equal(res.pluginStats["pi-bar"].used, true);

    assert.equal(res.pluginStats["omp-plugin-duplicate-detector"].calls, 1);
    assert.equal(res.pluginStats["omp-plugin-duplicate-detector"].used, true);

    assert.equal(res.pluginStats["@dietrichgebert/ponytail"].calls, 0);
    assert.equal(res.pluginStats["@dietrichgebert/ponytail"].used, false);

    assert.equal(res.pluginStats["pi-linter"].calls, 0);
    assert.equal(res.pluginStats["pi-linter"].used, false);

    // Unused plugins (from plugins.json with 0 calls)
    assert.deepEqual(res.unusedPlugins, [
      "@dietrichgebert/ponytail",
      "omp-url-pin",
      "pi-linter",
    ]);

    // Format audit report verification
    const report = formatAuditReport(res);
    assert.match(report, /--- ИСПОЛЬЗОВАНИЕ ПЛАГИНОВ OMP ---/);
    assert.match(report, /oh-my-pi-plugin-morph\s+:\s+2/);
    assert.match(report, /pi-lens\s+:\s+1/);
    assert.match(report, /--- НЕИСПОЛЬЗУЕМЫЕ ПЛАГИНЫ \(0 вызовов за 30 дней\) ---/);
    assert.match(report, /omp plugin disable @dietrichgebert\/ponytail/);
    assert.match(report, /omp plugin disable omp-url-pin/);
    assert.match(report, /omp plugin disable pi-linter/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("usage-audit CLI: accepts --plugins and outputs plugin sections", () => {
  const tmp = mkdtempSync(join(tmpdir(), "audit-cli-plugins-"));
  try {
    const sessionsDir = join(tmp, "sessions");
    mkdirSync(sessionsDir, { recursive: true });

    const line = JSON.stringify({
      type: "message",
      message: {
        role: "user",
        content: "/qq testing plugins in CLI",
      },
    });
    writeFileSync(join(sessionsDir, "test.jsonl"), line + "\n");

    const pluginsPath = join(tmp, "plugins.json");
    writeFileSync(
      pluginsPath,
      JSON.stringify({
        plugins: [
          { name: "pi-qq" },
          { name: "pi-bar" },
        ],
      })
    );

    // 1) Text report
    const textCli = runCli([
      "--sessions",
      sessionsDir,
      "--days",
      "30",
      "--plugins",
      pluginsPath,
    ]);
    assert.equal(textCli.status, 0);
    assert.match(textCli.stdout, /--- ИСПОЛЬЗОВАНИЕ ПЛАГИНОВ OMP ---/);
    assert.match(textCli.stdout, /pi-qq\s+:\s+1/);
    assert.match(textCli.stdout, /--- НЕИСПОЛЬЗУЕМЫЕ ПЛАГИНЫ/);
    assert.match(textCli.stdout, /omp plugin disable pi-bar/);

    // 2) JSON output
    const jsonCli = runCli([
      "--sessions",
      sessionsDir,
      "--days",
      "30",
      "--plugins",
      pluginsPath,
      "--json",
    ]);
    assert.equal(jsonCli.status, 0);
    const data = JSON.parse(jsonCli.stdout);
    assert.equal(data.pluginStats["pi-qq"].calls, 1);
    assert.equal(data.pluginStats["pi-qq"].used, true);
    assert.equal(data.pluginStats["pi-bar"].calls, 0);
    assert.equal(data.pluginStats["pi-bar"].used, false);
    assert.deepEqual(data.unusedPlugins, ["pi-bar"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
