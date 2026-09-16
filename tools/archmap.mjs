#!/usr/bin/env node
/**
 * archmap.mjs — architecture observability for humans.
 *
 * WHY THIS EXISTS
 * People working through agents lose the mental model of their own repository.
 * The agent edits files; the human sees a diff and a chat log, never the shape
 * of what is being built or whether it is getting better or worse. This produces
 * a single self-contained HTML page: the module graph, a health score, plain-
 * language findings, and what changed since the previous run.
 *
 * APPROACH
 * Static analysis only — no LLM, no network, no dependencies. It reuses
 * CodeBoarding's proven ideas (hash-based incremental state, a rendered artifact,
 * component-level narrative) but stays zero-install so it runs wherever the
 * harness does. Health uses the standard Maintainability Index (Microsoft's
 * normalised derivative), so the number is comparable to other tooling.
 *
 * COMMANDS
 *   scan    --root <dir>   analyze, write .archmap/state.json, and render report.html
 *   report  --root <dir>   re-render HTML from existing state
 *   diff    --root <dir>   text delta vs the previous snapshot
 *   json    --root <dir>   machine-readable summary (for an agent to read)
 *
 * Exit 0 ok, 2 cannot run. Zero dependencies. Node 18+ / Bun.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, relative, sep, extname, dirname, basename } from "node:path";
import { createHash } from "node:crypto";

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

/**
 * Per-language extraction. Kept deliberately small: imports (the graph edges),
 * exported names (the public surface), and a decision-point count for
 * complexity. A regex extractor can be wrong at the margins; it is never
 * confidently wrong in a way that changes a ranking, which is all this drives.
 */
const LANGS = {
  ".ts":  { import: [/import\s+(?:[\s\S]*?)\s+from\s+["']([^"']+)["']/g, /require\s*\(\s*["']([^"']+)["']\s*\)/g],
            export: [/export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g] },
  ".tsx": null, ".js": null, ".jsx": null, ".mjs": null, ".cjs": null,
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
            export: [/^(?:public\s+)?(?:class|struct|enum|protocol|func)\s+(\w+)/gm] },
  ".dart":{ import: [/^\s*import\s+["']([^"']+)["']/gm],
            export: [/^(?:abstract\s+)?class\s+(\w+)/gm] },
};
LANGS[".tsx"] = LANGS[".js"] = LANGS[".jsx"] = LANGS[".mjs"] = LANGS[".cjs"] = LANGS[".ts"];

const DECISION = /\b(if|else\s+if|for|while|case|catch|when)\b|&&|\|\||\?\.|\?\s*[^:]*:|@(?:app|router)\.(?:get|post|put|delete|patch)/g;

/* ------------------------------------------------------------------- utils */

function walk(root, out = [], depth = 0) {
  if (depth > 14) return out;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
      walk(full, out, depth + 1);
    } else if (e.isFile() && LANGS[extname(e.name)]) {
      out.push(full);
    }
  }
  return out;
}

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const posix = (p) => p.split(sep).join("/");

/** Resolve an import specifier to a tracked file, or null for an external package. */
function resolveImport(fromFile, spec, root, fileSet) {
  if (!spec) return null;
  const externals = /^(?:[a-z@][\w@/.-]*)$/i;
  if (spec.startsWith(".") || spec.startsWith("/")) {
    const base = dirname(fromFile);
    const target = posix(join(base, spec));
    const cands = [
      target, `${target}.ts`, `${target}.tsx`, `${target}.js`, `${target}.jsx`,
      `${target}/index.ts`, `${target}/index.tsx`, `${target}/index.js`,
      `${target}.py`, `${target}/__init__.py`,
      `${target}.rs`, `${target}.go`, `${target}.java`,
    ];
    for (const c of cands) if (fileSet.has(c)) return c;
    return null;
  }
  // Python / Go / Java style dotted paths.
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

  const imports = [...new Set(grab(lang.import))];
  const exports = [...new Set(grab(lang.export))];
  DECISION.lastIndex = 0;
  const complexity = 1 + (src.match(DECISION) || []).length;

  return {
    loc, blank, comment,
    complexity,
    imports,
    exports,
    bytes: Buffer.byteLength(src),
    hash: sha(src),
    // Halstead-lite: distinct operators/operands are not tracked, so this is a
    // proxy volume. It feeds the MI trend, never a hard gate.
    volume: Math.max(1, loc * Math.log2(Math.max(2, exports.length + imports.length + 1)) * 2),
  };
}

/** Tarjan strongly-connected components — returns cycles of length > 1. */
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

function scan(root) {
  const files = walk(root);
  const rel = files.map((f) => posix(relative(root, f)));
  const fileSet = new Set(rel);
  const byPath = new Map();

  files.forEach((full, i) => {
    const r = rel[i];
    const a = analyzeFile(full, root);
    // Resolve edges against tracked files only; externals are not our graph.
    const deps = [...new Set(a.imports.map((s) => resolveImport(r, s, root, fileSet)).filter(Boolean))];
    byPath.set(r, { ...a, path: r, dir: posix(dirname(r)), deps });
  });

  // fan-in / fan-out
  const fanIn = new Map(), fanOut = new Map();
  for (const [p, f] of byPath) { fanOut.set(p, f.deps.length); fanIn.set(p, 0); }
  for (const [, f] of byPath) for (const d of f.deps) fanIn.set(d, (fanIn.get(d) || 0) + 1);

  const graph = new Map();
  for (const [p, f] of byPath) graph.set(p, f.deps);
  const cycles = findCycles(graph);

  // Per-file Maintainability Index (Microsoft's normalised 0-100 derivative).
  // MI = max(0, (171 - 5.2*ln(V) - 0.23*G - 16.2*ln(LOC)) * 100 / 171)
  const mi = (f) => {
    const V = Math.max(1, f.volume), G = f.complexity, L = Math.max(1, f.loc);
    const raw = 171 - 5.2 * Math.log(V) - 0.23 * G - 16.2 * Math.log(L);
    return Math.max(0, Math.min(100, Math.round((raw * 100) / 171)));
  };

  const filesOut = {};
  for (const [p, f] of byPath) {
    filesOut[p] = {
      loc: f.loc, bytes: f.bytes, hash: f.hash, complexity: f.complexity,
      exports: f.exports.length, imports: f.imports.length,
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
    totals: { files: Object.keys(filesOut).length, loc: totalLoc, avgMi },
    cycles: cycles.map((c) => c.sort()),
    files: filesOut,
  };
}

/* ----------------------------------------------------------------- findings */

const LOC_BIG = 600, LOC_HUGE = 1200, CX_BIG = 60, FANIN_GOD = 8;

function findings(state) {
  const out = [];
  const files = Object.entries(state.files);

  for (const cyc of state.cycles) {
    out.push({
      severity: "high", kind: "cycle",
      what: `${cyc.length} files form a dependency cycle`,
      where: cyc.slice(0, 4),
      why: "Each one needs the other to compile, so they can only change together. This is the single biggest source of 'I touched one file and broke three'.",
      fix: "Break the loop at its weakest link: extract the shared piece into a third module both can import.",
    });
  }

  for (const [p, f] of files) {
    if (f.loc >= LOC_HUGE) out.push({
      severity: "high", kind: "size", where: [p],
      what: `${f.loc} lines in one file`, why: "Long files hide their own structure; nobody reads them end to end.",
      fix: "Split by responsibility — not by line count. Find the two things it does and separate them.",
    });
    else if (f.loc >= LOC_BIG) out.push({
      severity: "medium", kind: "size", where: [p],
      what: `${f.loc} lines`, why: "Large enough that its responsibilities are probably mixed.",
      fix: "Check whether two distinct concerns live here.",
    });

    if (f.complexity >= CX_BIG) out.push({
      severity: "medium", kind: "complexity", where: [p],
      what: `complexity ${f.complexity} (${f.complexity} branches)`,
      why: "Every branch is a case someone must hold in their head, and a path tests can miss.",
      fix: "Extract the deepest nested branch into a named function.",
    });

    if (f.fanIn >= FANIN_GOD && f.loc >= LOC_BIG) out.push({
      severity: "high", kind: "hub", where: [p],
      what: `imported by ${f.fanIn} files and ${f.loc} lines long`,
      why: "Everything routes through it. A change here has repo-wide blast radius, and it cannot be tested in isolation.",
      fix: "Split it along the axis its importers actually use.",
    });

    if (f.fanIn === 0 && f.fanOut === 0 && !/^(?:index|main|cli|app|server|entry)\./i.test(basename(p))) {
      out.push({
        severity: "low", kind: "orphan", where: [p],
        what: "nothing imports it and it imports nothing",
        why: "Either an entry point, or dead code nobody noticed.",
        fix: "If nothing runs it, delete it. Dead code costs reading time forever.",
      });
    }

    if (f.exports === 1 && f.loc < 15 && f.fanIn > 0) out.push({
      severity: "low", kind: "wrapper", where: [p],
      what: `a ${f.loc}-line file with a single export`,
      why: "A pass-through adds a hop without hiding anything. Apply the deletion test: does removing it simplify nothing?",
      fix: "Inline it into its only consumer, or make it actually hide something.",
    });
  }

  for (const [p, f] of files) {
    if (f.mi < 40) out.push({
      severity: "medium", kind: "maintainability", where: [p],
      what: `maintainability index ${f.mi}/100`,
      why: "Low MI means high effort to change safely.",
      fix: "Reduce size or branching — MI is dominated by length and branches.",
    });
  }

  const order = { high: 0, medium: 1, low: 2 };
  const sorted = out.sort((a, b) => order[a.severity] - order[b.severity] || a.kind.localeCompare(b.kind));

  // A list of 177 findings is not a finding — a human cannot act on it, so it
  // reads as noise and gets ignored. Keep every high, then the worst N of the
  // rest by measurable weight (lines + branches above threshold), and record
  // how many were suppressed so the report never implies it showed everything.
  const weight = (f) => {
    const p = f.where[0];
    const m = /^(\d+) lines/.exec(f.what);
    if (m) return parseInt(m[1], 10);
    const c = /complexity (\d+)/.exec(f.what);
    if (c) return parseInt(c[1], 10) * 8;
    return f.kind === "maintainability" ? 500 : 100;
  };
  const highs = sorted.filter((f) => f.severity === "high");
  const rest = sorted.filter((f) => f.severity !== "high").sort((a, b) => weight(b) - weight(a));
  const CAP = 12;
  const shown = [...highs, ...rest.slice(0, CAP)];
  const suppressed = Math.max(0, rest.length - CAP);
  return { shown, suppressed, total: sorted.length };
}

/* --------------------------------------------------------------------- diff */

function diff(prev, next) {
  if (!prev) return { first: true, added: [], removed: [], changed: [], scores: null };
  const added = [], removed = [], changed = [];
  for (const [p, f] of Object.entries(next.files)) {
    const old = prev.files[p];
    if (!old) { added.push(p); continue; }
    if (old.hash !== f.hash) {
      changed.push({ path: p, loc: f.loc - old.loc, cx: f.complexity - old.complexity, mi: f.mi - old.mi });
    }
  }
  for (const p of Object.keys(prev.files)) if (!(p in next.files)) removed.push(p);

  const newCycles = next.cycles.filter((c) => !prev.cycles.some((o) => o.join() === c.join()));
  const fixedCycles = prev.cycles.filter((c) => !next.cycles.some((o) => o.join() === c.join()));

  return {
    first: false,
    added, removed, changed,
    newCycles, fixedCycles,
    scores: {
      loc: next.totals.loc - prev.totals.loc,
      mi: next.totals.avgMi - prev.totals.avgMi,
      files: next.totals.files - prev.totals.files,
    },
  };
}

/* ------------------------------------------------------------------ render */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** Deterministic layered layout: nodes grouped by import depth, laid out in columns. */
function layout(state) {
  const files = Object.keys(state.files);
  const depth = new Map();
  const compute = (p, seen = new Set()) => {
    if (depth.has(p)) return depth.get(p);
    if (seen.has(p)) return 0;             // cycle: stop descending
    seen.add(p);
    const deps = state.files[p].deps;
    const d = deps.length ? 1 + Math.max(...deps.map((x) => compute(x, seen))) : 0;
    depth.set(p, d);
    return d;
  };
  for (const p of files) compute(p);
  const layers = new Map();
  for (const p of files) {
    const d = depth.get(p) || 0;
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d).push(p);
  }
  const maxDepth = Math.max(0, ...[...layers.keys()]);
  const colW = 220, rowH = 26, padX = 30, padY = 40;
  const pos = new Map();
  let maxRows = 0;
  for (const [d, list] of layers) {
    list.sort();
    maxRows = Math.max(maxRows, list.length);
    list.forEach((p, i) => {
      const x = padX + (maxDepth - d) * colW;   // dependencies on the right
      const y = padY + i * rowH;
      pos.set(p, { x, y });
    });
  }
  return { pos, maxRows, maxDepth, colW, rowH, padX, padY };
}

function renderSvg(state, L) {
  const { pos, colW, rowH, padX, padY } = L;
  const width = padX * 2 + (L.maxDepth + 1) * colW;
  const height = padY + L.maxRows * rowH + 30;
  const nodeW = 165, nodeH = 17;

  const edges = [];
  for (const [p, f] of Object.entries(state.files)) {
    for (const d of f.deps) {
      const a = pos.get(p), b = pos.get(d);
      if (!a || !b) continue;
      const x1 = a.x + nodeW, y1 = a.y + nodeH / 2;
      const x2 = b.x, y2 = b.y + nodeH / 2;
      const mx = (x1 + x2) / 2;
      edges.push(`<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" fill="none" stroke="#c7ccd6" stroke-width="1"/>`);
    }
  }

  const cycSet = new Set(state.cycles.flat());
  const nodes = [];
  for (const [p, f] of Object.entries(state.files)) {
    const { x, y } = pos.get(p);
    const bad = cycSet.has(p), big = f.loc >= LOC_BIG;
    const fill = bad ? "#fee2e2" : big ? "#fef3c7" : "#eef2ff";
    const stroke = bad ? "#dc2626" : big ? "#d97706" : "#c7d2fe";
    const label = basename(p).length > 22 ? basename(p).slice(0, 21) + "…" : basename(p);
    nodes.push(
      `<g><title>${esc(p)}\n${f.loc} lines · complexity ${f.complexity} · MI ${f.mi} · imported by ${f.fanIn}</title>` +
      `<rect x="${x}" y="${y}" width="${nodeW}" height="${nodeH}" rx="4" fill="${fill}" stroke="${stroke}"/>` +
      `<text x="${x + 6}" y="${y + 12}" font-size="10" fill="#1f2937" font-family="ui-monospace,monospace">${esc(label)}</text>` +
      `<text x="${x + nodeW - 6}" y="${y + 12}" font-size="9" fill="#6b7280" text-anchor="end" font-family="ui-monospace,monospace">${f.loc}</text>` +
      `</g>`);
  }
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" style="max-width:${width}px" role="img" aria-label="module dependency graph">
  <defs><marker id="a" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="#c7ccd6"/></marker></defs>
  ${edges.join("\n  ")}
  ${nodes.join("\n  ")}
</svg>`;
}

function renderHtml(state, d, find) {
  const shown = find.shown;
  const L = layout(state);
  const svg = renderSvg(state, L);
  const score = state.totals.avgMi;
  const band = score >= 75 ? ["good", "#16a34a"] : score >= 55 ? ["fair", "#d97706"] : ["poor", "#dc2626"];
  const bySeverity = { high: [], medium: [], low: [] };
  for (const f of shown) (bySeverity[f.severity] || bySeverity.low).push(f);

  const findingCard = (f) => `<div class="finding ${f.severity}">
    <div class="fhead"><span class="sev ${f.severity}">${f.severity}</span><strong>${esc(f.what)}</strong></div>
    <div class="where">${f.where.map((w) => `<code>${esc(w)}</code>`).join(" ")}</div>
    <p class="why">${esc(f.why)}</p>
    <p class="fix"><b>What to do:</b> ${esc(f.fix)}</p>
  </div>`;

  const deltaBlock = d.first
    ? `<p class="muted">First scan — no previous snapshot to compare against. Run again after changes to see the delta.</p>`
    : `<div class="grid">
        <div class="stat"><span>${d.scores.files >= 0 ? "+" : ""}${d.scores.files}</span><label>files</label></div>
        <div class="stat"><span>${d.scores.loc >= 0 ? "+" : ""}${d.scores.loc}</span><label>lines</label></div>
        <div class="stat ${d.scores.mi >= 0 ? "up" : "down"}"><span>${d.scores.mi >= 0 ? "+" : ""}${d.scores.mi}</span><label>health</label></div>
      </div>
      ${d.added.length ? `<h3>Added (${d.added.length})</h3><ul class="files">${d.added.slice(0, 20).map((p) => `<li><code>${esc(p)}</code></li>`).join("")}</ul>` : ""}
      ${d.removed.length ? `<h3>Removed (${d.removed.length})</h3><ul class="files">${d.removed.slice(0, 20).map((p) => `<li><code>${esc(p)}</code></li>`).join("")}</ul>` : ""}
      ${d.newCycles.length ? `<h3 class="bad">New dependency cycles (${d.newCycles.length})</h3><ul class="files">${d.newCycles.map((c) => `<li><code>${c.map(esc).join(" → ")}</code></li>`).join("")}</ul>` : ""}
      ${d.fixedCycles.length ? `<h3 class="good">Cycles broken (${d.fixedCycles.length})</h3><ul class="files">${d.fixedCycles.map((c) => `<li><code>${c.map(esc).join(" → ")}</code></li>`).join("")}</ul>` : ""}
      ${d.changed.length ? `<h3>Modified (${d.changed.length})</h3><table><tr><th>file</th><th>lines</th><th>branches</th><th>health</th></tr>
        ${d.changed.sort((a, b) => Math.abs(b.loc) - Math.abs(a.loc)).slice(0, 25).map((c) =>
          `<tr><td><code>${esc(c.path)}</code></td><td class="${c.loc > 0 ? "bad" : c.loc < 0 ? "good" : ""}">${c.loc >= 0 ? "+" : ""}${c.loc}</td><td>${c.cx >= 0 ? "+" : ""}${c.cx}</td><td class="${c.mi >= 0 ? "good" : "bad"}">${c.mi >= 0 ? "+" : ""}${c.mi}</td></tr>`).join("")}
      </table>` : ""}`;

  const top = Object.entries(state.files)
    .sort((a, b) => b[1].loc - a[1].loc).slice(0, 15);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Architecture — ${esc(basename(state.root))}</title>
<style>
  :root { --bg:#f8fafc; --card:#fff; --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }
  .wrap { max-width:1180px; margin:0 auto; padding:32px 24px 64px }
  h1 { font-size:26px; margin:0 0 4px } h2 { font-size:18px; margin:36px 0 12px }
  h3 { font-size:14px; margin:20px 0 8px; color:var(--muted); text-transform:uppercase; letter-spacing:.06em }
  .muted { color:var(--muted) } code { font:12px ui-monospace,SFMono-Regular,monospace; background:#f1f5f9; padding:1px 5px; border-radius:4px }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px; margin:16px 0 }
  .score { display:flex; align-items:baseline; gap:14px }
  .score .n { font-size:52px; font-weight:700; line-height:1 }
  .score .of { color:var(--muted) }
  .grid { display:flex; gap:24px; flex-wrap:wrap; margin:4px 0 12px }
  .stat { display:flex; flex-direction:column }
  .stat span { font-size:24px; font-weight:600 } .stat label { font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.05em }
  .stat.up span { color:#16a34a } .stat.down span { color:#dc2626 }
  .finding { border-left:3px solid var(--line); padding:10px 0 10px 14px; margin:12px 0 }
  .finding.high { border-color:#dc2626 } .finding.medium { border-color:#d97706 } .finding.low { border-color:#94a3b8 }
  .fhead { display:flex; align-items:center; gap:8px; flex-wrap:wrap }
  .sev { font-size:10px; text-transform:uppercase; letter-spacing:.08em; padding:2px 7px; border-radius:99px; font-weight:700 }
  .sev.high { background:#fee2e2; color:#b91c1c } .sev.medium { background:#fef3c7; color:#b45309 } .sev.low { background:#e2e8f0; color:#475569 }
  .where { margin:5px 0 } .why { margin:6px 0 0; color:#334155 } .fix { margin:4px 0 0; color:#0f172a }
  .files { margin:4px 0; padding-left:18px } .files li { margin:2px 0 }
  table { border-collapse:collapse; width:100%; font-size:13px }
  th,td { text-align:left; padding:5px 8px; border-bottom:1px solid var(--line) }
  th { color:var(--muted); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.05em }
  .good { color:#16a34a } .bad { color:#dc2626 }
  .legend { display:flex; gap:16px; flex-wrap:wrap; font-size:12px; color:var(--muted); margin-top:8px }
  .sw { display:inline-block; width:11px; height:11px; border-radius:2px; margin-right:5px; vertical-align:-1px }
  footer { margin-top:48px; color:var(--muted); font-size:12px; border-top:1px solid var(--line); padding-top:14px }
</style></head><body><div class="wrap">

<h1>Architecture report</h1>
<p class="muted">${esc(state.root)} · scanned ${esc(state.scannedAt.replace("T", " ").slice(0, 16))}</p>

<div class="card">
  <div class="score">
    <div class="n" style="color:${band[1]}">${score}</div>
    <div><div class="of">/ 100 maintainability</div><div class="muted" style="font-size:13px">${band[0]} · ${state.totals.files} files · ${state.totals.loc.toLocaleString()} lines</div></div>
  </div>
  <p class="muted" style="font-size:13px;margin:12px 0 0">
    Average Maintainability Index across all files (Microsoft's normalised formula: length and branching dominate).
    85+ is comfortable, 65–85 is workable, below 65 means changes get risky.
  </p>
</div>

<h2>What changed</h2>
<div class="card">${deltaBlock}</div>

<h2>How it fits together</h2>
<div class="card">
  ${svg}
  <div class="legend">
    <span><i class="sw" style="background:#eef2ff;border:1px solid #c7d2fe"></i>normal</span>
    <span><i class="sw" style="background:#fef3c7;border:1px solid #d97706"></i>large file (600+ lines)</span>
    <span><i class="sw" style="background:#fee2e2;border:1px solid #dc2626"></i>in a dependency cycle</span>
    <span>arrows point at what a file imports · number on the right is line count</span>
  </div>
</div>

<h2>What to look at</h2>
${shown.length ? `<div class="card">${shown.map(findingCard).join("")}${
    find.suppressed ? `<p class="muted" style="margin-top:16px;border-top:1px solid var(--line);padding-top:12px">
      ${find.suppressed} more lower-priority finding(s) not shown — the list above is capped so it stays actionable.
      Run <code>archmap.mjs json</code> for the full set.</p>` : ""}</div>`
  : `<div class="card"><p class="muted">Nothing flagged. No cycles, no oversized files, no orphaned code.</p></div>`}

<h2>Largest files</h2>
<div class="card"><table>
  <tr><th>file</th><th>lines</th><th>branches</th><th>health</th><th>imported by</th></tr>
  ${top.map(([p, f]) => `<tr><td><code>${esc(p)}</code></td><td>${f.loc}</td><td>${f.complexity}</td>
    <td class="${f.mi >= 65 ? "good" : f.mi >= 40 ? "" : "bad"}">${f.mi}</td><td>${f.fanIn}</td></tr>`).join("")}
</table></div>

<footer>
  Generated by <code>archmap.mjs</code> — static analysis only, no code left this machine.
  Re-run <code>node &lt;harness&gt;/tools/archmap.mjs scan</code> after changes to refresh the delta.
  ${find.total ? `Priority: ${bySeverity.high.length} high · ${bySeverity.medium.length} medium · ${bySeverity.low.length} low shown (${find.total} total).` : ""}
</footer>
</div></body></html>`;
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

const args = parse(process.argv.slice(2));
const root = args.flags.root ? String(args.flags.root) : process.cwd();
const cmd = args._[0] || "scan";
const stateFile = join(root, DIR, STATE);
const prevFile = join(root, DIR, "previous.json");
const readJson = (p) => {
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, "")); } catch { return null; }
};
// For scan, `prev` is the state on disk (what we are about to replace).
// For diff/report, the delta is between the last scan and the one before it —
// otherwise `diff` after a scan would always report zero.
const prev = readJson(stateFile);

if (!existsSync(root)) { console.error(`archmap: no such directory: ${root}`); process.exit(2); }

function loadOrScan() {
  if (cmd === "report" || cmd === "diff" || cmd === "json") {
    if (!prev) { console.error("archmap: no snapshot. Run `scan` first."); process.exit(2); }
    return prev;
  }
  return scan(root);
}

const state = loadOrScan();
const find = findings(state);       // { shown, suppressed, total }

// For read-only commands the comparison base is the snapshot BEFORE the last
// scan. Fall back to "no previous" when only one scan has ever run.
const baseForRead = cmd === "scan" ? prev : (readJson(prevFile) || null);

if (cmd === "scan") {
  mkdirSync(join(root, DIR), { recursive: true });
  // Compute the delta BEFORE overwriting state, then persist a copy of the
  // previous snapshot so `diff` (which only reads from disk) can reproduce it.
  const d = diff(prev, state);
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  if (prev) writeFileSync(join(root, DIR, "previous.json"), JSON.stringify(prev, null, 2));
  const html = renderHtml(state, d, find);
  writeFileSync(join(root, DIR, REPORT), html);
  console.log(`archmap: ${state.totals.files} files · ${state.totals.loc} lines · MI ${state.totals.avgMi}/100`);
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
process.exit(0);
