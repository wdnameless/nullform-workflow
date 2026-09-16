#!/usr/bin/env node
/**
 * archmap.mjs — architecture observability for humans.
 *
 * Provides module & call graph static analysis, health scores, Russian architectural findings,
 * and offline report rendering.
 *
 * COMMANDS
 *   scan    --root <dir>   analyze, write .archmap/state.json, and render architecture.html
 *   report  --root <dir>   re-render HTML from existing state
 *   diff    --root <dir>   text delta vs the previous snapshot
 *   json    --root <dir>   machine-readable summary (including symbols/calls/analysis)
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, relative, sep, extname, dirname, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
// Renderer is provided by sibling tools/archmap-report.mjs
let renderHtml = null;
try {
  const reportMod = await import("./archmap-report.mjs");
  renderHtml = reportMod.renderHtml;
} catch {
  // Fallback placeholder if report module is not yet integrated in this worktree
  renderHtml = (state) => `<!doctype html><html><head><meta charset="utf-8"><title>Archmap</title></head><body><pre>${JSON.stringify(state, null, 2)}</pre></body></html>`;
}
import { analyzeProjectJsTs } from "./archmap-analysis.mjs";

const DIR = ".archmap";
const STATE = "state.json";
const REPORT = "architecture.html";

const SKIP = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "target",
  "coverage", "__pycache__", ".venv", "venv", "vendor", ".turbo", ".archmap",
  ".codemap", ".workflow", ".prompt-lint", "migrations", "fixtures", "assets",
  "public", "static", "locales", "i18n",
]);

/* --------------------------------------------------------------- languages */

const LANGS = {
  ".ts":  { import: [/import\s+(?:[\s\S]*?)\s+from\s+["']([^"']+)["']/g, /require\s*\(\s*["']([^"']+)["']\s*\)/g],
            export: [/export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g] },
  ".tsx": null, ".js": null, ".jsx": null, ".mjs": null, ".cjs": null, ".mts": null, ".cts": null,
  ".py":  { import: [/^\s*from\s+([\w.]+)\s+import/gm, /^\s*import\s+([\w.]+)/gm],
            export: [/^(?:class|def)\s+([A-Za-z_]\w*)/gm] },
  ".rs":  { import: [/^\s*use\s+([\w:]+)/gm],
            export: [/^pub\s+(?:fn|struct|enum|trait|const|type)\s+([A-Za-z_]\w*)/gm] },
  ".go":  { import: [/^\s*"([\w./-]+)"/gm],
            export: [/^func\s+([A-Z]\w*)/gm, /^type\s+([A-Z]\w*)/gm] },
  ".java":{ import: [/^\s*import\s+([\w.]+);/gm],
            export: [/^\s*public\s+(?:final\s+)?(?:class|interface|enum|record)\s+(\w+)/gm] },
  ".kt":  { import: [/^\s*import\s+([\w.]+)/gm],
            export: [/^(?:fun|class|object|interface)\s+(\w+)/gm] },
  ".cs":  { import: [/^\s*using\s+([\w.]+);/gm],
            export: [/^\s*public\s+(?:sealed\s+|abstract\s+)?(?:class|interface|enum|record|struct)\s+(\w+)/gm] },
  ".rb":  { import: [/^\s*require(?:_relative)?\s+["']([^"']+)["']/gm],
            export: [/^\s*(?:class|module)\s+([A-Z]\w*)/gm, /^\s*def\s+(?:self\.)?([a-z_]\w*[?!]?)/gm] },
  ".php": { import: [/^\s*use\s+([\w\\]+);/gm],
            export: [/^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait)\s+(\w+)/gm] },
  ".swift":{ import: [/^\s*import\s+(\w+)/gm],
            export: [/^(?:public\s+)?(?:class|struct|enum|protocol)\s+(\w+)/gm] },
  ".dart":{ import: [/^\s*import\s+["']([^"']+)["']/gm],
            export: [/^(?:abstract\s+)?class\s+(\w+)/gm] },
};
LANGS[".tsx"] = LANGS[".js"] = LANGS[".jsx"] = LANGS[".mjs"] = LANGS[".cjs"] = LANGS[".mts"] = LANGS[".cts"] = LANGS[".ts"];

const MEMBERS = {
  ".ts":  [
    [/^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm, "function"],
    [/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm, "class"],
    [/^\s*export\s+interface\s+([A-Za-z_$][\w$]*)/gm, "interface"],
    [/^\s*export\s+type\s+([A-Za-z_$][\w$]*)/gm, "type"],
    [/^\s*export\s+(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/gm, "function"],
  ],
  ".py":  [
    [/^class\s+([A-Za-z_]\w*)/gm, "class"],
    [/^def\s+([A-Za-z_]\w*)/gm, "function"],
    [/^(\w+)\s*:\s*Final\s*=/gm, "constant"],
  ],
  ".rs":  [[/^pub\s+fn\s+([A-Za-z_]\w*)/gm, "function"],
           [/^pub\s+(?:struct|enum)\s+([A-Za-z_]\w*)/gm, "type"],
           [/^pub\s+trait\s+([A-Za-z_]\w*)/gm, "trait"]],
  ".go":  [[/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/gm, "function"],
           [/^type\s+([A-Z]\w*)/gm, "type"]],
  ".java":[[/^\s*public\s+[\w<>\[\]]+\s+(\w+)\s*\(/gm, "method"],
           [/^\s*public\s+(?:final\s+)?(?:class|interface|enum|record)\s+(\w+)/gm, "type"]],
  ".kt":  [[/^fun\s+(\w+)/gm, "function"], [/^(?:class|object|interface)\s+(\w+)/gm, "type"]],
  ".cs":  [[/^\s*public\s+[\w<>\[\]]+\s+(\w+)\s*\(/gm, "method"],
           [/^\s*public\s+(?:sealed\s+|abstract\s+)?(?:class|interface|enum|record|struct)\s+(\w+)/gm, "type"]],
  ".rb":  [[/^\s*def\s+(?:self\.)?([a-z_]\w*[?!]?)/gm, "method"], [/^\s*(?:class|module)\s+([A-Z]\w*)/gm, "type"]],
  ".php": [[/^\s*(?:(?:public|protected|private)\s+)?function\s+(\w+)/gm, "method"],
           [/^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait)\s+(\w+)/gm, "type"]],
  ".swift":[[/^(?:public\s+)?func\s+(\w+)/gm, "function"], [/^(?:public\s+)?(?:class|struct|enum|protocol)\s+(\w+)/gm, "type"]],
  ".dart": [[/^\s*(?:[A-Z]\w*[\w<>?,\s]*)\s+(\w+)\s*\(/gm, "method"], [/^(?:abstract\s+)?class\s+(\w+)/gm, "type"]],
};
for (const k of [".js", ".jsx", ".mjs", ".cjs", ".tsx", ".mts", ".cts"]) MEMBERS[k] = MEMBERS[".ts"];

function lineAt(newlines, offset) {
  let lo = 0, hi = newlines.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (newlines[mid] <= offset) lo = mid; else hi = mid - 1; }
  return lo + 1;
}

function extractMembers(src, ext) {
  const specs = MEMBERS[ext] || [];
  const newlines = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) newlines.push(i + 1);
  const out = [];
  const seen = new Set();
  for (const [re, kind] of specs) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const name = m[1];
      const id = kind + ":" + name;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ name, kind, line: lineAt(newlines, m.index) });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

const DECISION = /\b(if|else\s+if|for|while|case|catch|when)\b|&&|\|\||\?\.|\?\s*[^:]*:|@(?:app|router)\.(?:get|post|put|delete|patch)/g;

/* ------------------------------------------------------------------- utils */

let SCOPE = null;

function walk(root, out = [], depth = 0, top = "") {
  if (depth > 14) return out;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
      const nextTop = top || e.name;
      if (SCOPE && depth === 0 && !SCOPE.includes(e.name)) continue;
      walk(full, out, depth + 1, nextTop);
    } else if (e.isFile() && LANGS[extname(e.name)]) {
      out.push(full);
    }
  }
  return out;
}

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const posix = (p) => p.split(sep).join("/");

function resolveImport(fromFile, spec, root, fileSet) {
  if (!spec) return null;
  const externals = /^(?:[a-z@][\w@/.-]*)$/i;
  if (spec.startsWith(".") || spec.startsWith("/")) {
    const base = dirname(fromFile);
    const target = posix(join(base, spec));
    const cands = [
      target, `${target}.ts`, `${target}.tsx`, `${target}.js`, `${target}.jsx`,
      `${target}.mjs`, `${target}.cjs`, `${target}.mts`, `${target}.cts`,
      `${target}/index.ts`, `${target}/index.tsx`, `${target}/index.js`,
      `${target}/index.mjs`, `${target}/index.cjs`, `${target}/index.mts`, `${target}/index.cts`,
      `${target}.py`, `${target}/__init__.py`,
      `${target}.rs`, `${target}.go`, `${target}.java`,
    ];
    for (const c of cands) if (fileSet.has(c)) return c;
    return null;
  }
  const dotted = spec.replace(/\./g, "/");
  for (const c of [`${dotted}.py`, `${dotted}/__init__.py`, `${dotted}.go`, `${dotted}.rs`]) {
    if (fileSet.has(c)) return c;
  }
  return externals.test(spec) && !spec.includes("/") ? null : null;
}

/* ------------------------------------------------------------------ analyze */

function analyzeFile(fullPath, root) {
  const src = readFileSync(fullPath, "utf8").replace(/\r\n/g, "\n");
  const ext = extname(fullPath);
  const lang = LANGS[ext];

  const lines = src.split("\n");
  let loc = 0, blank = 0, comment = 0;
  let inBlock = false;
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) { blank++; continue; }
    if (inBlock) { comment++; if (l.includes("*/")) inBlock = false; continue; }
    if (l.startsWith("/*")) { comment++; if (!l.includes("*/")) inBlock = true; continue; }
    if (/^(?:\/\/|#|--|\*)/.test(l)) { comment++; continue; }
    loc++;
  }

  const grab = (res) => {
    const out = [];
    for (const re of res || []) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src)) !== null) out.push(m[1]);
    }
    return out;
  };

  const imports = [...new Set(grab(lang?.import))];
  const exports = [...new Set(grab(lang?.export))];
  const members = extractMembers(src, ext);
  DECISION.lastIndex = 0;
  const complexity = 1 + (src.match(DECISION) || []).length;

  return {
    loc, blank, comment,
    complexity,
    imports,
    exports,
    members,
    bytes: Buffer.byteLength(src),
    hash: sha(src),
    volume: Math.max(1, loc * Math.log2(Math.max(2, exports.length + imports.length + 1)) * 2),
  };
}

function findCycles(graph) {
  let idx = 0;
  const stack = [], onStack = new Set(), index = new Map(), low = new Map(), cycles = [];
  const strongconnect = (v) => {
    index.set(v, idx); low.set(v, idx); idx++;
    stack.push(v); onStack.add(v);
    for (const w of graph.get(v) || []) {
      if (!index.has(w)) { strongconnect(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onStack.has(w)) { low.set(v, Math.min(low.get(v), index.get(w))); }
    }
    if (low.get(v) === index.get(v)) {
      const comp = [];
      let w;
      do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1) cycles.push(comp);
    }
  };
  for (const v of graph.keys()) if (!index.has(v)) strongconnect(v);
  return cycles;
}

function mi(f) {
  const v = f.volume;
  const g = f.complexity;
  const raw = 171 - 5.2 * Math.log(Math.max(1, v)) - 0.23 * g - 16.2 * Math.log(Math.max(1, f.loc));
  const norm = Math.max(0, (raw * 100) / 171);
  return Math.round(Math.min(100, norm));
}

async function scan(root) {
  const files = walk(root);
  const rel = files.map((f) => posix(relative(root, f)));
  const fileSet = new Set(rel);
  const byPath = new Map();

  files.forEach((full, i) => {
    const r = rel[i];
    const a = analyzeFile(full, root);
    const deps = [...new Set(a.imports.map((s) => resolveImport(r, s, root, fileSet)).filter(Boolean))];
    byPath.set(r, { ...a, path: r, dir: posix(dirname(r)), deps });
  });

  // Semantic JS/TS symbols, static call graph and unresolved tracking
  const jsTsAnalysis = await analyzeProjectJsTs(root, rel, byPath);

  // Merge exact JS/TS file dependencies if discovered by compiler
  if (jsTsAnalysis && jsTsAnalysis.fileDeps) {
    for (const [p, deps] of Object.entries(jsTsAnalysis.fileDeps)) {
      if (byPath.has(p) && Array.isArray(deps)) {
        const existing = byPath.get(p);
        const merged = Array.from(new Set([...existing.deps, ...deps])).filter((d) => fileSet.has(d));
        existing.deps = merged;
      }
    }
  }

  const fanIn = new Map(), fanOut = new Map();
  for (const [p, f] of byPath) { fanOut.set(p, f.deps.length); fanIn.set(p, 0); }
  for (const [, f] of byPath) for (const d of f.deps) fanIn.set(d, (fanIn.get(d) || 0) + 1);

  const graph = new Map();
  for (const [p, f] of byPath) graph.set(p, f.deps);
  const cycles = findCycles(graph);

  const filesOut = {};
  for (const [p, f] of byPath) {
    filesOut[p] = {
      loc: f.loc, blank: f.blank, comment: f.comment,
      bytes: f.bytes, hash: f.hash, complexity: f.complexity,
      exports: f.exports.length, imports: f.imports.length,
      members: f.members,
      deps: f.deps, fanIn: fanIn.get(p) || 0, fanOut: fanOut.get(p) || 0,
      mi: mi(f),
    };
  }

  const totalLoc = Object.values(filesOut).reduce((s, f) => s + f.loc, 0);
  const avgMi = Object.values(filesOut).length
    ? Math.round(Object.values(filesOut).reduce((s, f) => s + f.mi, 0) / Object.values(filesOut).length)
    : 0;
  return {
    version: 1,
    scannedAt: new Date().toISOString(),
    root: posix(root),
    scope: SCOPE || null,
    totals: { files: Object.keys(filesOut).length, loc: totalLoc, avgMi },
    cycles: cycles.map((c) => c.sort()),
    files: filesOut,
    symbols: jsTsAnalysis.symbols,
    calls: jsTsAnalysis.calls,
    unresolvedCalls: jsTsAnalysis.unresolvedCalls,
    analysis: jsTsAnalysis.analysis,
  };
}

/* ----------------------------------------------------------------- findings */

const LOC_BIG = 600, LOC_HUGE = 1200, CX_BIG = 60, FANIN_GOD = 8;

function findings(state) {
  const out = [];
  const files = Object.entries(state.files || {});

  for (const cyc of state.cycles || []) {
    out.push({
      severity: "high", kind: "cycle",
      rawWeight: 1000 + cyc.length * 50,
      what: `Циклическая зависимость: ${cyc.length} файлов зациклены`,
      where: cyc.slice(0, 4),
      why: "Файлы зависят друг от друга и не могут компилироваться или тестироваться изолированно. Изменение одного затрагивает весь цикл.",
      fix: "Разорвите цикл: выделите общий интерфейс или разделяемые типы в отдельный модуль.",
    });
  }

  for (const [p, f] of files) {
    if (f.loc >= LOC_HUGE) {
      out.push({
        severity: "high", kind: "size", where: [p],
        rawWeight: f.loc,
        what: `Критический размер файла: ${f.loc} строк`,
        why: "Слишком большой объем скрывает архитектурную структуру и усложняет чтение и аудит.",
        fix: "Разделите файл по зонам ответственности на несколько сфокусированных модулей.",
      });
    } else if (f.loc >= LOC_BIG) {
      out.push({
        severity: "medium", kind: "size", where: [p],
        rawWeight: f.loc,
        what: `Большой размер файла: ${f.loc} строк`,
        why: "Модуль превысил порог компактности; вероятно смешение нескольких обязанностей.",
        fix: "Проверьте, не выполняет ли файл несколько не связанных между собой задач.",
      });
    }

    if (f.complexity >= CX_BIG) {
      out.push({
        severity: "medium", kind: "complexity", where: [p],
        rawWeight: f.complexity * 10,
        what: `Высокая цикломатическая сложность: ${f.complexity} ветвлений`,
        why: "Большое количество ветвлений повышает вероятность багов и снижает тестовое покрытие.",
        fix: "Выделите вложенные ветвления и условия во вспомогательные функции.",
      });
    }

    if (f.fanIn >= FANIN_GOD && f.loc >= LOC_BIG) {
      out.push({
        severity: "high", kind: "hub", where: [p],
        rawWeight: f.loc + f.fanIn * 50,
        what: `Узловой файл (God-объект): ${f.fanIn} входящих зависимостей, ${f.loc} строк`,
        why: "Через этот файл проходит слишком много путей системы; любое изменение несет общесистемный риск.",
        fix: "Разбейте модуль вдоль интерфейсов конкретных потребителей.",
      });
    }

    if (f.fanIn === 0 && f.fanOut === 0 && !/^(?:index|main|cli|app|server|entry)\./i.test(basename(p))) {
      out.push({
        severity: "low", kind: "orphan", where: [p],
        rawWeight: 50,
        what: "Изолированный файл: нет входящих и исходящих зависимостей",
        why: "Файл не импортируется проектом; это может быть забытый код или точка входа без конфигурации.",
        fix: "Если код не используется в проде или тестах, удалите его.",
      });
    }

    const exportCount = typeof f.exports === "number" ? f.exports : (Array.isArray(f.exports) ? f.exports.length : 0);
    if (exportCount === 1 && f.loc < 15 && f.fanIn > 0) {
      out.push({
        severity: "low", kind: "wrapper", where: [p],
        rawWeight: 30,
        what: `Тонкая обертка: ${f.loc} строк с единственным экспортом`,
        why: "Модуль проксирует вызов без добавления ценности или сокрытия сложности.",
        fix: "Встройте логику напрямую в потребитель или обеспечьте полноценное сокрытие реализации.",
      });
    }

    if (f.mi < 40) {
      out.push({
        severity: "medium", kind: "maintainability", where: [p],
        rawWeight: (100 - f.mi) * 5,
        what: `Низкий индекс сопровождаемости (MI): ${f.mi}/100`,
        why: "Низкий MI свидетельствует о высокой когнитивной нагрузке при модификации модуля.",
        fix: "Уменьшите длину файла и разгрузите ветвления логики.",
      });
    }
  }

  const order = { high: 0, medium: 1, low: 2 };
  const sorted = out.sort((a, b) => order[a.severity] - order[b.severity] || (b.rawWeight || 0) - (a.rawWeight || 0));

  const CAP = 12;
  const highs = sorted.filter((f) => f.severity === "high");
  const rest = sorted.filter((f) => f.severity !== "high");
  const shown = [...highs, ...rest.slice(0, CAP)];
  const suppressed = Math.max(0, rest.length - CAP);

  // Clean rawWeight helper field before returning
  for (const item of sorted) delete item.rawWeight;

  return { shown, suppressed, total: sorted.length };
}

/* --------------------------------------------------------------------- diff */

function diff(prev, next) {
  if (!prev) return { first: true, added: [], removed: [], changed: [], scores: null, newCycles: [], fixedCycles: [] };
  const added = [], removed = [], changed = [];
  for (const [p, f] of Object.entries(next.files || {})) {
    const old = prev.files?.[p];
    if (!old) { added.push(p); continue; }
    if (old.hash !== f.hash) {
      changed.push({ path: p, loc: f.loc - old.loc, cx: f.complexity - old.complexity, mi: f.mi - old.mi });
    }
  }
  for (const p of Object.keys(prev.files || {})) if (!(p in (next.files || {}))) removed.push(p);

  const prevCycles = prev.cycles || [];
  const nextCycles = next.cycles || [];
  const newCycles = nextCycles.filter((c) => !prevCycles.some((o) => o.join() === c.join()));
  const fixedCycles = prevCycles.filter((c) => !nextCycles.some((o) => o.join() === c.join()));

  return {
    first: false,
    added, removed, changed,
    newCycles, fixedCycles,
    scores: {
      loc: (next.totals?.loc || 0) - (prev.totals?.loc || 0),
      mi: (next.totals?.avgMi || 0) - (prev.totals?.avgMi || 0),
      files: (next.totals?.files || 0) - (prev.totals?.files || 0),
    },
  };
}

/* ---------------------------------------------------------------------- main */

function parse(argv) {
  const o = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const n = argv[i + 1];
      if (n !== undefined && !n.startsWith("--")) { o.flags[a.slice(2)] = n; i++; }
      else o.flags[a.slice(2)] = true;
    } else o._.push(a);
  }
  return o;
}

async function runCli() {
  const args = parse(process.argv.slice(2));
  const root = args.flags.root ? String(args.flags.root) : process.cwd();

  if (args.flags.scope) {
    const want = String(args.flags.scope).split(",").map((x) => x.trim()).filter(Boolean);
    SCOPE = want.filter((d) => existsSync(join(root, d)));
    if (!SCOPE.length) { console.error(`archmap: --scope matched no directories under ${root}`); process.exit(2); }
  }

  const cmd = args._[0] || "scan";
  const stateFile = join(root, DIR, STATE);
  const prevFile = join(root, DIR, "previous.json");
  const readJson = (p) => {
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, "")); } catch { return null; }
  };

  const prev = readJson(stateFile);
  if (!existsSync(root)) { console.error(`archmap: no such directory: ${root}`); process.exit(2); }

  async function loadOrScan() {
    if (cmd === "report" || cmd === "diff" || cmd === "json") {
      if (!prev) { console.error("archmap: no snapshot. Run `scan` first."); process.exit(2); }
      return prev;
    }
    return await scan(root);
  }

  const state = await loadOrScan();
  const find = findings(state);
  const baseForRead = cmd === "scan" ? prev : (readJson(prevFile) || null);

  if (cmd === "scan") {
    mkdirSync(join(root, DIR), { recursive: true });
    const d = diff(prev, state);
    writeFileSync(stateFile, JSON.stringify(state, null, 2));
    if (prev) writeFileSync(join(root, DIR, "previous.json"), JSON.stringify(prev, null, 2));
    const html = renderHtml(state, d, find);
    writeFileSync(join(root, DIR, REPORT), html);
    console.log(`archmap: ${state.totals.files} files · ${state.totals.loc} lines · MI ${state.totals.avgMi}/100`);
    if (state.symbols) {
      console.log(`  symbols: ${state.symbols.length} · calls: ${state.calls?.length || 0} · unresolved: ${state.unresolvedCalls?.length || 0}`);
    }
    const hc = find.shown.filter((f) => f.severity === "high").length;
    const mc = find.shown.filter((f) => f.severity === "medium").length;
    const lc = find.shown.filter((f) => f.severity === "low").length;
    console.log(`  findings: ${hc} high, ${mc} medium, ${lc} low shown${find.suppressed ? ` (${find.suppressed} more suppressed)` : ""} of ${find.total}`);
    if (!d.first) {
      const sgn = (n) => (n >= 0 ? "+" : "") + n;
      console.log(`  since last scan: ${sgn(d.scores.files)} files, ${sgn(d.scores.loc)} lines, health ${sgn(d.scores.mi)}`);
      if (d.newCycles.length) console.log(`  NEW CYCLES: ${d.newCycles.length}`);
    }
    console.log(`  report: ${posix(join(DIR, REPORT))}`);
  } else if (cmd === "report") {
    writeFileSync(join(root, DIR, REPORT), renderHtml(state, diff(baseForRead, state), find));
    console.log(`archmap: re-rendered ${posix(join(DIR, REPORT))}`);
  } else if (cmd === "diff") {
    const d = diff(baseForRead, state);
    if (d.first) console.log("archmap: no previous snapshot.");
    else {
      const sgn = (n) => (n >= 0 ? "+" : "") + n;
      console.log(`archmap delta: ${sgn(d.scores.files)} files, ${sgn(d.scores.loc)} lines, health ${sgn(d.scores.mi)}`);
      for (const p of d.added) console.log(`  A ${p}`);
      for (const p of d.removed) console.log(`  D ${p}`);
      for (const c of d.changed) console.log(`  M ${c.path} (${sgn(c.loc)} lines)`);
      for (const c of d.newCycles) console.log(`  ! new cycle: ${c.join(" -> ")}`);
    }
  } else if (cmd === "json") {
    const d = diff(baseForRead, state);
    console.log(JSON.stringify({
      totals: state.totals,
      delta: d.first ? null : d.scores,
      cycles: state.cycles.length,
      symbols: state.symbols || [],
      calls: state.calls || [],
      unresolvedCalls: state.unresolvedCalls || [],
      analysis: state.analysis || null,
      findingsShown: find.shown.length,
      findingsTotal: find.total,
      findingsSuppressed: find.suppressed,
      findings: find.shown.map((f) => ({ severity: f.severity, kind: f.kind, what: f.what, where: f.where, fix: f.fix })),
    }, null, 2));
  } else {
    console.log("archmap.mjs — architecture observability\n");
    console.log("  node archmap.mjs scan   --root .   # analyze + write architecture.html");
    console.log("  node archmap.mjs report --root .   # re-render from the last snapshot");
    console.log("  node archmap.mjs diff   --root .   # text delta");
    console.log("  node archmap.mjs json   --root .   # machine-readable, for an agent");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((err) => {
    console.error("archmap error:", err);
    process.exit(2);
  });
}
