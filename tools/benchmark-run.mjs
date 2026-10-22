/**
 * benchmark-run.mjs — детерминированный синтетический бенчмарк прогона T2-воркфлоу.
 * Без сети и платных вызовов.
 * Переиспользует normalizedCost из tools/cost-snapshot.mjs.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizedCost } from "./cost-snapshot.mjs";

/**
 * Каноническая синтетическая фикстура контрольного T2-прогона (Brief -> Recon -> Spec -> Build -> Oracle).
 */
export const CANONICAL_BENCHMARK = Object.freeze({
  name: "synthetic-t2-control",
  tier: "T2",
  tests: 16,
  roles: {
    "@orchestrator": {
      calls: 4,
      usage: { output: 450, cacheWrite: 1200, cacheRead: 6000 },
      ms: 1250,
      tests: 0,
    },
    "@explorer": {
      calls: 6,
      usage: { output: 850, cacheWrite: 2400, cacheRead: 14500 },
      ms: 2100,
      tests: 0,
    },
    "@fixer": {
      calls: 12,
      usage: { output: 1600, cacheWrite: 4800, cacheRead: 32000 },
      ms: 5400,
      tests: 12,
    },
    "@oracle": {
      calls: 3,
      usage: { output: 350, cacheWrite: 800, cacheRead: 4500 },
      ms: 1150,
      tests: 4,
    },
  },
});

function loadFixture(target) {
  if (!target) return CANONICAL_BENCHMARK;
  if (typeof target === "object" && target !== null) {
    if (target.roles) return target;
  }

  const p = resolve(String(target));
  if (!existsSync(p)) return CANONICAL_BENCHMARK;

  const st = statSync(p);
  if (st.isFile()) {
    if (p.endsWith(".jsonl")) {
      return parseJsonlFixture(p);
    }
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.roles) return parsed;
    } catch {}
    return CANONICAL_BENCHMARK;
  }

  if (st.isDirectory()) {
    const candidates = ["benchmark.json", "fixture.json", "run.json", "costs.json"];
    for (const name of candidates) {
      const file = join(p, name);
      if (existsSync(file)) {
        try {
          const parsed = JSON.parse(readFileSync(file, "utf8"));
          if (parsed && typeof parsed === "object" && parsed.roles) return parsed;
        } catch {}
      }
    }

    // Try finding JSONL files
    try {
      const jsonlFiles = readdirSync(p).filter((f) => f.endsWith(".jsonl"));
      if (jsonlFiles.length > 0) {
        return parseJsonlFixture(join(p, jsonlFiles[0]));
      }
    } catch {}
  }

  return CANONICAL_BENCHMARK;
}

function parseJsonlFixture(filePath) {
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const roles = {};
  let tests = 0;
  let ms = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      const role = ev.role || ev.agent || (ev.message?.role === "assistant" ? "@assistant" : null) || "@worker";
      if (!roles[role]) {
        roles[role] = { calls: 0, usage: { output: 0, cacheWrite: 0, cacheRead: 0 }, ms: 0, tests: 0 };
      }
      roles[role].calls++;
      const u = ev.usage || ev.message?.usage || {};
      roles[role].usage.output += Number(u.output ?? u.out ?? 0);
      roles[role].usage.cacheWrite += Number(u.cacheWrite ?? u.write ?? 0);
      roles[role].usage.cacheRead += Number(u.cacheRead ?? u.read ?? 0);
      roles[role].ms += Number(ev.durationMs ?? ev.ms ?? 0);
      roles[role].tests += Number(ev.tests ?? 0);
      ms += Number(ev.durationMs ?? ev.ms ?? 0);
      tests += Number(ev.tests ?? 0);
    } catch {}
  }

  return { roles, tests, ms };
}

/**
 * Запуск синтетического бенчмарка на фикстуре.
 *
 * @param {string|object|null} fixtureDir Путь к фикстуре или объект
 * @returns {{ roles: Record<string, any>, total: number, tests: number, ms: number }}
 */
export function runBenchmark(fixtureDir = null) {
  const source = loadFixture(fixtureDir);
  const rolesMap = source.roles || {};
  const roles = {};

  let totalUnits = 0;
  let totalTests = typeof source.tests === "number" ? source.tests : 0;
  let totalMs = typeof source.ms === "number" ? source.ms : 0;

  const roleEntries = Object.entries(rolesMap);
  for (const [roleName, rawData] of roleEntries) {
    const data = rawData || {};
    const usage = data.usage || data;
    const cost = normalizedCost(usage, roleName);

    const calls = Number(data.calls) || 1;
    const out = Number(usage.output ?? usage.out ?? 0);
    const write = Number(usage.cacheWrite ?? usage.write ?? 0);
    const read = Number(usage.cacheRead ?? usage.read ?? 0);
    const duration = Number(data.ms ?? data.durationMs ?? 0);
    const roleTests = Number(data.tests ?? 0);

    roles[roleName] = {
      role: roleName,
      calls,
      output: out,
      cacheWrite: write,
      cacheRead: read,
      units: cost.units,
      cacheChurn: cost.cacheChurn,
      ms: duration,
      tests: roleTests,
    };

    totalUnits += cost.units;
    if (typeof source.tests !== "number") totalTests += roleTests;
    if (typeof source.ms !== "number") totalMs += duration;
  }

  // Округляем до сотых для детерминированности
  const total = Math.round(totalUnits * 100) / 100;

  return {
    roles,
    total,
    tests: totalTests,
    ms: totalMs,
  };
}

// CLI entry point
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  let fixture = null;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--fixture" && args[i + 1]) {
      fixture = args[++i];
    } else if (args[i] === "--json") {
      json = true;
    }
  }

  const result = runBenchmark(fixture);

  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write("\n=== Nullform Universal-1 Benchmark ===\n");
    process.stdout.write("Role              | Calls | Output | CacheW | CacheR | Units    | Churn | Duration\n");
    process.stdout.write("------------------+-------+--------+--------+--------+----------+-------+---------\n");
    for (const r of Object.values(result.roles)) {
      const name = r.role.padEnd(17);
      const calls = String(r.calls).padStart(5);
      const out = String(r.output).padStart(6);
      const write = String(r.cacheWrite).padStart(6);
      const read = String(r.cacheRead).padStart(6);
      const units = String(r.units).padStart(8);
      const churn = (r.cacheChurn ? "WARN" : "OK").padEnd(5);
      const ms = `${r.ms}ms`.padStart(7);
      process.stdout.write(`${name} | ${calls} | ${out} | ${write} | ${read} | ${units} | ${churn} | ${ms}\n`);
    }
    process.stdout.write("------------------+-------+--------+--------+--------+----------+-------+---------\n");
    process.stdout.write(`Total Units: ${result.total} | Tests: ${result.tests} passed | Time: ${result.ms}ms\n\n`);
  }
}
