import fs from "node:fs";

/**
 * tools/archmap-report.mjs
 *
 * Self-contained offline HTML architecture explorer renderer.
 * Dark minimalist Russian engineering interface.
 * Zero external assets, no CDN, offline-first.
 */

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));

/** Translate standard English phrases and findings safely into Russian */
const KIND_RU = {
  cycle: "Цикл зависимостей",
  size: "Размер файла",
  complexity: "Цикломатическая сложность",
  hub: "Узел зацепления (хаб)",
  orphan: "Изолированный файл",
  wrapper: "Тонкая обёртка",
  maintainability: "Индекс поддерживаемости",
  dead: "Мёртвый код",
};

const SEV_RU = {
  critical: "критический",
  high: "высокий",
  medium: "средний",
  low: "низкий",
};

const PROBLEM_CATEGORY_RU = {
  structure: "Структура",
  optimization: "Оптимизация",
  security: "Безопасность",
  reliability: "Надёжность",
  maintainability: "Сопровождаемость",
};

const PROBLEM_SEVERITY_RU = {
  critical: "критический",
  high: "высокий",
  medium: "средний",
  low: "низкий",
};

const SYM_KIND_RU = {
  function: "функция",
  method: "метод",
  class: "класс",
  constructor: "конструктор",
  getter: "геттер",
  setter: "сеттер",
  module: "модуль",
  type: "тип",
  interface: "интерфейс",
  trait: "трейт",
  constant: "константа",
};

const REASON_RU = {
  external: "Внешняя библиотека или системный рантайм",
  dynamic: "Динамический вызов (вызов параметра, свойство по ключу, возврат функции)",
  unresolved: "Неразрешённый идентификатор в контексте проекта",
  unsupported: "Конструкция вне возможностей статического анализа",
};

function ruPlural(n, one, few, many) {
  const abs = Math.abs(n) % 100;
  const d = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (d > 1 && d < 5) return few;
  if (d === 1) return one;
  return many;
}

function translateFindingText(text) {
  if (!text) return "";
  let s = String(text);
  s = s.replace(/(\d+)\s+files form a dependency cycle/g, "$1 файлов образуют цикл взаимных зависимостей");
  s = s.replace(/Each one needs the other to compile, so they can only change together\..*$/g, "Каждый модуль зависит от другого; их невозможно изменять и компилировать изолированно. Источник каскадных поломок.");
  s = s.replace(/Break the loop at its weakest link: extract the shared piece into a third module both can import\./g, "Разорвите цикл в слабейшем звене: вынесите общий фрагмент в отдельный независимый модуль.");
  s = s.replace(/(\d+)\s+lines in one file/g, "$1 строк в одном файле");
  s = s.replace(/(\d+)\s+lines/g, "$1 строк");
  s = s.replace(/Long files hide their own structure; nobody reads them end to end\./g, "Крупные файлы скрывают свою структуру и затрудняют анализ архитектуры.");
  s = s.replace(/Split by responsibility — not by line count\. Find the two things it does and separate them\./g, "Разделите файл по зонам ответственности, выделив самостоятельные подсистемы.");
  s = s.replace(/Large enough that its responsibilities are probably mixed\./g, "Объём файла указывает на возможное смешение нескольких обязанностей.");
  s = s.replace(/Check whether two distinct concerns live here\./g, "Проверьте, не выполняет ли файл несколько не связанных задач.");
  s = s.replace(/complexity\s+(\d+)\s+\((\d+)\s+branches\)/g, "сложность $1 ($2 точек ветвления)");
  s = s.replace(/Every branch is a case someone must hold in their head, and a path tests can miss\./g, "Каждое ветвление увеличивает число комбинаций состояний и риск упустить пограничный сценарий в тестах.");
  s = s.replace(/Extract the deepest nested branch into a named function\./g, "Вынесите вложенные ветвления и условия в отдельные функции.");
  s = s.replace(/imported by\s+(\d+)\s+files and\s+(\d+)\s+lines long/g, "импортируется $1 файлами при длине в $2 строк");
  s = s.replace(/Everything routes through it\. A change here has repo-wide blast radius, and it cannot be tested in isolation\./g, "Через модуль проходит слишком много потоков. Изменения здесь имеют максимальный радиус поражения.");
  s = s.replace(/Split it along the axis its importers actually use\./g, "Разделите модуль по интерфейсам, требуемым конкретным потребителям.");
  s = s.replace(/nothing imports it and it imports nothing/g, "файл никем не импортируется и ничего не импортирует");
  s = s.replace(/Either an entry point, or dead code nobody noticed\./g, "Либо точка входа, либо неиспользуемый изолированный код.");
  s = s.replace(/If nothing runs it, delete it\. Dead code costs reading time forever\./g, "Если файл не вызывается извне или тестов, удалите его.");
  s = s.replace(/a\s+(\d+)-line file with a single export/g, "файл из $1 строк с единственным экспортом");
  s = s.replace(/A pass-through adds a hop without hiding anything\..*$/g, "Сквозной прокси-модуль не инкапсулирует логику, а лишь удлиняет цепочку вызовов.");
  s = s.replace(/Inline it into its only consumer, or make it actually hide something\./g, "Встройте логику по месту вызова либо наделите модуль реальной ответственностью.");
  s = s.replace(/Maintainability Index is\s+(\d+)\/100/g, "Индекс поддерживаемости равен $1/100");
  s = s.replace(/Hard to read, test, or modify safely\..*$/g, "Код сложен для чтения, рефакторинга и покрытия тестами.");
  s = s.replace(/Simplify branches, split functions, and reduce cognitive load\./g, "Упростите ветвления, разбейте крупные функции и снизьте когнитивную нагрузку.");
  s = s.replace(/\bdynamic\b/gi, "динамический");
  s = s.replace(/\bexternal\b/gi, "внешний");
  s = s.replace(/\bunresolved\b/gi, "неразрешённый");
  s = s.replace(/\bunsupported\b/gi, "неподдерживаемый");
  return s;
}

/** Extract top-level directory for a file */
function getTopFolder(p) {
  const norm = String(p || "").replace(/\\/g, "/");
  const parts = norm.split("/");
  if (parts.length > 1) {
    return parts[0];
  }
  return "(корень)";
}

/** Layout for modules graph: layered topological sort */
function layoutModules(state) {
  const files = Object.keys(state.files || {});
  if (!files.length) {
    return { pos: new Map(), width: 600, height: 300, maxDepth: 0 };
  }
  const depth = new Map();
  const compute = (p, seen = new Set()) => {
    if (depth.has(p)) return depth.get(p);
    if (seen.has(p)) return 0;
    seen.add(p);
    const deps = (state.files[p] && state.files[p].deps) || [];
    const d = deps.length ? 1 + Math.max(0, ...deps.map((x) => compute(x, seen))) : 0;
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
  const colW = 260, rowH = 42, padX = 40, padY = 50;
  const pos = new Map();
  const maxLayerRows = 24;
  let maxVirtualRows = 0;
  let totalCols = maxDepth + 1;
  let currentColOffset = 0;

  for (let d = maxDepth; d >= 0; d--) {
    const list = layers.get(d) || [];
    list.sort();
    const numSubCols = Math.max(1, Math.ceil(list.length / maxLayerRows));
    const effectiveRows = Math.min(list.length, maxLayerRows);
    maxVirtualRows = Math.max(maxVirtualRows, effectiveRows);
    list.forEach((p, i) => {
      const subCol = Math.floor(i / maxLayerRows);
      const subRow = i % maxLayerRows;
      pos.set(p, {
        x: padX + (currentColOffset + subCol) * colW,
        y: padY + subRow * rowH,
        depth: d,
      });
    });
    currentColOffset += numSubCols;
  }
  const width = Math.max(700, padX * 2 + currentColOffset * colW);
  const height = Math.max(400, padY + maxVirtualRows * rowH + 60);
  return { pos, width, height, maxDepth };
}

/** Build SCC map to accurately identify cycle membership */
function buildCycleMap(cycles) {
  const cycleMap = new Map();
  if (!Array.isArray(cycles)) return cycleMap;
  cycles.forEach((comp, idx) => {
    if (!Array.isArray(comp)) return;
    for (const node of comp) {
      if (!cycleMap.has(node)) cycleMap.set(node, new Set());
      cycleMap.get(node).add(idx);
    }
  });
  return cycleMap;
}

/** Pre-render SVG for initial module mode */
function renderModuleSvg(state, L) {
  const filesList = Object.keys(state.files || {});
  const clusterDefault = filesList.length > 40;
  const cycleMap = buildCycleMap(state.cycles);
  const nodeW = 200, nodeH = 26;
  const edges = [];
  const files = Object.entries(state.files || {});

  if (clusterDefault) {
    // Cluster initial render: top-level folders
    const folders = new Map();
    for (const [p, f] of files) {
      const fld = getTopFolder(p);
      if (!folders.has(fld)) folders.set(fld, { count: 0, loc: 0, files: [] });
      const rec = folders.get(fld);
      rec.count++;
      rec.loc += (f.loc || 0);
      rec.files.push(p);
    }
    const fldKeys = [...folders.keys()].sort();
    const cols = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(fldKeys.length))));
    const cW = 240, cH = 46, gapX = 30, gapY = 20;
    const svgW = Math.max(700, 40 * 2 + cols * (cW + gapX));
    const svgH = Math.max(400, 50 * 2 + Math.ceil(fldKeys.length / cols) * (cH + gapY) + 40);

    const nodes = fldKeys.map((fld, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const x = 40 + col * (cW + gapX);
      const y = 50 + row * (cH + gapY);
      const rec = folders.get(fld);
      return (
        `<g class="node node-cluster" tabindex="0" role="button" aria-label="Папка ${esc(fld)}, ${rec.count} файлов" data-id="cluster:${esc(fld)}" data-folder="${esc(fld)}" transform="translate(${x},${y})">` +
        `<rect width="${cW}" height="${cH}" rx="8"/>` +
        `<text class="nt" x="12" y="20">📁 ${esc(fld)}/</text>` +
        `<text class="nl" x="${cW - 12}" y="20" text-anchor="end">${rec.count} ${ruPlural(rec.count, "файл", "файла", "файлов")}</text>` +
        `<text class="muted" x="12" y="36" style="font-size:10.5px">${rec.loc} стр кода · клик: развернуть</text>` +
        `</g>`
      );
    });

    return `<svg id="graph" viewBox="0 0 ${svgW} ${svgH}">
  <defs>
    <marker id="arrow" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="#3b4557"/>
    </marker>
    <marker id="arrow-cycle" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="#f87171"/>
    </marker>
    <marker id="arrow-active" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="#60a5fa"/>
    </marker>
  </defs>
  <g id="viewport">
    <g id="edge-layer"></g>
    <g id="node-layer">${nodes.join("\n    ")}</g>
  </g>
</svg>`;
  }

  for (const [p, f] of files) {
    for (const dep of f.deps || []) {
      const a = L.pos.get(p), b = L.pos.get(dep);
      if (!a || !b) continue;
      const x1 = a.x + nodeW, y1 = a.y + nodeH / 2;
      const x2 = b.x, y2 = b.y + nodeH / 2;
      const mx = (x1 + x2) / 2;
      const pCyc = cycleMap.get(p);
      const depCyc = cycleMap.get(dep);
      let inCycle = false;
      if (pCyc && depCyc) {
        for (const cId of pCyc) {
          if (depCyc.has(cId)) {
            inCycle = true;
            break;
          }
        }
      }
      edges.push(
        `<path class="edge${inCycle ? " edge-cycle" : ""}" data-from="${esc(p)}" data-to="${esc(dep)}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" marker-end="url(#${inCycle ? "arrow-cycle" : "arrow"})"/>`
      );
    }
  }

  const nodes = [];
  for (const [p, f] of files) {
    const coords = L.pos.get(p);
    if (!coords) continue;
    const { x, y } = coords;
    const inCycle = cycleMap.has(p);
    const big = f.loc >= 600;
    const cls = inCycle ? "cyc" : big ? "big" : "nrm";
    const label = p.length > 27 ? "…" + p.slice(-26) : p;
    nodes.push(
      `<g class="node node-module ${cls}" tabindex="0" role="button" aria-label="Модуль ${esc(p)}" data-id="${esc(p)}" data-path="${esc(p)}" transform="translate(${x},${y})">` +
      `<rect width="${nodeW}" height="${nodeH}" rx="6"/>` +
      `<text class="nt" x="9" y="17">${esc(label)}</text>` +
      `<text class="nl" x="${nodeW - 9}" y="17" text-anchor="end">${f.loc} стр</text>` +
      `</g>`
    );
  }

  return `<svg id="graph" viewBox="0 0 ${L.width} ${L.height}">
  <defs>
    <marker id="arrow" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="#3b4557"/>
    </marker>
    <marker id="arrow-cycle" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="#f87171"/>
    </marker>
    <marker id="arrow-active" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="#60a5fa"/>
    </marker>
  </defs>
  <g id="viewport">
    <g id="edge-layer">${edges.join("\n    ")}</g>
    <g id="node-layer">${nodes.join("\n    ")}</g>
  </g>
</svg>`;
}

/** Embed safely into HTML */
function embedData(state, delta, findings) {
  const payload = {
    root: state.root || "",
    scannedAt: state.scannedAt || "",
    totals: state.totals || { files: 0, loc: 0, avgMi: 0 },
    cycles: state.cycles || [],
    files: {},
    symbols: state.symbols || [],
    calls: state.calls || [],
    unresolvedCalls: state.unresolvedCalls || [],
    analysis: state.analysis || {
      engine: "regex-heuristic",
      supportedExtensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
      limitations: ["Вызовы функций поддерживаются для JS/TS (.ts, .tsx, .js, .jsx, .mjs, .cjs)."],
      diagnostics: [],
    },
    delta: delta || null,
    findings: findings || { shown: [], suppressed: 0, total: 0 },
    problems: state.problems || null,
  };

  const jsTsExts = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

  for (const [p, f] of Object.entries(state.files || {})) {
    const extMatch = p.match(/\.[^.]+$/);
    const ext = extMatch ? extMatch[0].toLowerCase() : "";
    const isJsTs = jsTsExts.has(ext);

    payload.files[p] = {
      loc: f.loc || 0,
      complexity: f.complexity || 0,
      mi: f.mi || 0,
      fanIn: f.fanIn || 0,
      fanOut: f.fanOut || 0,
      deps: f.deps || [],
      members: (f.members || []).map((m) => ({
        name: m.name || m.n || "",
        kind: m.kind || m.k || "item",
        line: m.line || m.l || 1,
        heuristic: m.heuristic !== undefined ? m.heuristic : !isJsTs,
      })),
    };
  }

  return JSON.stringify(payload).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

/**
 * Main exported renderer function.
 * Must match: renderHtml(state, delta, findings): string
 */
export function renderHtml(state, delta, findings) {
  const safeState = state || { root: ".", scannedAt: new Date().toISOString(), files: {}, totals: { files: 0, loc: 0, avgMi: 0 }, cycles: [] };
  const safeDelta = delta || { first: true, added: [], removed: [], changed: [], newCycles: [], fixedCycles: [], scores: null };
  const safeFindings = findings || { shown: [], suppressed: 0, total: 0 };
  const safeProblems = Array.isArray(safeState.problems) ? safeState.problems : [];

  const supportedExtensions = (safeState.analysis && Array.isArray(safeState.analysis.supportedExtensions))
    ? safeState.analysis.supportedExtensions
    : [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
  const supportedExtText = `TypeScript и JavaScript (${supportedExtensions.join(", ")})`;
  const score = safeState.totals ? safeState.totals.avgMi : 0;
  const band =
    score >= 75
      ? ["good", "#34d399", "высокая поддерживаемость"]
      : score >= 55
      ? ["fair", "#fbbf24", "умеренная сложность"]
      : ["poor", "#f87171", "высокий риск деградации"];

  const L = layoutModules(safeState);
  const initialSvg = renderModuleSvg(safeState, L);

  const shown = safeFindings.shown || [];
  const bySev = { high: [], medium: [], low: [] };
  for (const f of shown) (bySev[f.severity] || bySev.low).push(f);

  const findingCard = (f) => {
    const sevLabel = SEV_RU[f.severity] || f.severity || "инфо";
    const kindLabel = KIND_RU[f.kind] || f.kind || "замечание";
    const whatText = translateFindingText(f.what);
    const whyText = translateFindingText(f.why);
    const fixText = translateFindingText(f.fix);

    return `<div class="finding ${esc(f.severity || "low")}">
      <div class="fhead">
        <span class="sev ${esc(f.severity || "low")}">${esc(sevLabel)}</span>
        <span class="fkind">${esc(kindLabel)}</span>
        <strong>${esc(whatText)}</strong>
      </div>
      <div class="where">
        ${(f.where || []).map((w) => `<code class="flink" tabindex="0" role="button" aria-label="Открыть файл ${esc(w)}" data-path="${esc(w)}">${esc(w)}</code>`).join(" ")}
      </div>
      <p class="why">${esc(whyText)}</p>
      ${fixText ? `<p class="fix"><b>Рекомендация:</b> ${esc(fixText)}</p>` : ""}
    </div>`;
  };

  const deltaBlock = safeDelta.first
    ? `<p class="muted">Первый снимок репозитория — сравнительная динамика будет рассчитана при повторном анализе.</p>`
    : `<div class="grid">
        <div class="stat"><span>${safeDelta.scores && safeDelta.scores.files >= 0 ? "+" : ""}${safeDelta.scores ? safeDelta.scores.files : 0}</span><label>Файлы</label></div>
        <div class="stat"><span>${safeDelta.scores && safeDelta.scores.loc >= 0 ? "+" : ""}${safeDelta.scores ? safeDelta.scores.loc : 0}</span><label>Строки</label></div>
        <div class="stat ${(safeDelta.scores && safeDelta.scores.mi >= 0) ? "up" : "down"}"><span>${safeDelta.scores && safeDelta.scores.mi >= 0 ? "+" : ""}${safeDelta.scores ? safeDelta.scores.mi : 0}</span><label>Индекс MI</label></div>
      </div>
      ${safeDelta.added && safeDelta.added.length ? `<h3>Добавленные файлы (${safeDelta.added.length})</h3><ul class="files">${safeDelta.added.slice(0, 20).map((p) => `<li><code class="flink" tabindex="0" role="button" aria-label="Открыть файл ${esc(p)}" data-path="${esc(p)}">${esc(p)}</code></li>`).join("")}</ul>` : ""}
      ${safeDelta.removed && safeDelta.removed.length ? `<h3>Удалённые файлы (${safeDelta.removed.length})</h3><ul class="files">${safeDelta.removed.slice(0, 20).map((p) => `<li><code>${esc(p)}</code></li>`).join("")}</ul>` : ""}
      ${safeDelta.newCycles && safeDelta.newCycles.length ? `<h3 class="bad">Появились новые циклы (${safeDelta.newCycles.length})</h3><ul class="files">${safeDelta.newCycles.map((c) => `<li><code>${c.map(esc).join(" → ")}</code></li>`).join("")}</ul>` : ""}
      ${safeDelta.fixedCycles && safeDelta.fixedCycles.length ? `<h3 class="good">Устранены циклы (${safeDelta.fixedCycles.length})</h3><ul class="files">${safeDelta.fixedCycles.map((c) => `<li><code>${c.map(esc).join(" → ")}</code></li>`).join("")}</ul>` : ""}
      ${safeDelta.changed && safeDelta.changed.length ? `<h3>Изменённые файлы (${safeDelta.changed.length})</h3><table><tr><th>Файл</th><th>Строки</th><th>Ветвления</th><th>Индекс MI</th></tr>
        ${safeDelta.changed.sort((a, b) => Math.abs(b.loc) - Math.abs(a.loc)).slice(0, 25).map((c) =>
          `<tr><td><code class="flink" tabindex="0" role="button" aria-label="Открыть файл ${esc(c.path)}" data-path="${esc(c.path)}">${esc(c.path)}</code></td><td class="${c.loc > 0 ? "bad" : c.loc < 0 ? "good" : ""}">${c.loc >= 0 ? "+" : ""}${c.loc}</td><td>${c.cx >= 0 ? "+" : ""}${c.cx}</td><td class="${c.mi >= 0 ? "good" : "bad"}">${c.mi >= 0 ? "+" : ""}${c.mi}</td></tr>`).join("")}
      </table>` : ""}`;

  const topFiles = Object.entries(safeState.files || {})
    .sort((a, b) => (b[1].loc || 0) - (a[1].loc || 0))
    .slice(0, 15);

  const cycleList = safeState.cycles && safeState.cycles.length
    ? `<div class="cyclewarn">
        <b>Обнаружены циклы зависимостей (${safeState.cycles.length}):</b>
        <ul>${safeState.cycles.map((c) => `<li><code>${c.map(esc).join(" → ")}</code></li>`).join("")}</ul>
      </div>`
    : "";

  const totalSymbols = safeState.symbols ? safeState.symbols.length : 0;
  const totalCalls = safeState.calls ? safeState.calls.length : 0;
  const totalUnresolved = safeState.unresolvedCalls ? safeState.unresolvedCalls.length : 0;
  const analysisEngine = safeState.analysis && safeState.analysis.engine ? safeState.analysis.engine : "стандартный";
  const problemsCount = safeProblems.length || (safeFindings.total || shown.length);

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Архитектурный отчёт — ${esc(String(safeState.root || "").split(/[\\/]/).pop() || "проект")}</title>
<style>
${loadCss()}
</style>
</head>
<body>
<div class="wrap">

<header>
  <h1>Архитектурный анализ</h1>
  <p class="sub">${esc(safeState.root || "")} · снимок от ${esc(String(safeState.scannedAt || "").replace("T", " ").slice(0, 16))}</p>
</header>

<div class="card">
  <div class="score-row">
    <div class="score-num" style="color:${band[1]}">${score}</div>
    <div class="score-meta">
      <div class="score-title">Индекс поддерживаемости (Maintainability Index, Microsoft MI)</div>
      <div class="muted">${band[2]} · ${safeState.totals.files} ${ruPlural(safeState.totals.files, "файл", "файла", "файлов")} · ${safeState.totals.loc.toLocaleString("ru-RU")} ${ruPlural(safeState.totals.loc, "строка", "строки", "строк")} кода</div>
    </div>
  </div>
  <div class="bar"><i style="width:${Math.max(2, Math.min(100, score))}%;background:${band[1]}"></i></div>
  <p class="score-desc">Формула MI нормализована по шкале 0–100 на основе метрик Холстеда, цикломатической сложности Маккейба и физического объема строк кода. Отражает структурную сложность сопровождения.</p>
</div>

<h2>Граф архитектуры</h2>
<div class="card" id="graph-card">
  ${cycleList}
  <div class="graph-toolbar">
    <div class="graph-controls">
      <div class="btn-group" role="tablist" id="view-tabs" aria-label="Режимы отображения">
        <button class="btn-tab active" id="tab-modules" role="tab" aria-selected="true" aria-pressed="true" tabindex="0">Модули (${safeState.totals.files})</button>
        <button class="btn-tab" id="tab-calls" role="tab" aria-selected="false" aria-pressed="false" tabindex="-1">Вызовы (${totalCalls})</button>
        <button class="btn-tab" id="tab-problems" role="tab" aria-selected="false" aria-pressed="false" tabindex="-1">Проблемы (${problemsCount})</button>
      </div>
      <div class="graph-actions" id="graph-actions">
        <button class="btn-action" id="btn-connected-filter" style="display:none" title="Переключить показ изолированных символов">Все символы</button>
        <button class="btn-action" id="btn-cluster-toggle" style="display:none" title="Развернуть все папки">Развернуть всё</button>
        <button class="btn-action" id="btn-back-to-map" style="display:none" title="Вернуться к общей карте">← К карте</button>
        <button class="btn-action" id="btn-fit" title="Центрировать и подогнать масштаб">Сбросить зум</button>
        <button class="btn-action" id="btn-fs" title="Развернуть на весь экран">Во весь экран</button>
      </div>
    </div>
    <div class="search-box">
      <input type="text" class="search-input" id="search-input" placeholder="Поиск модулей, функций и проблем..." autocomplete="off">
      <div class="search-results" id="search-results"></div>
    </div>
  </div>

  <div class="graphwrap" id="gw">
    <button class="fullscreen-exit" id="btn-exit-fs">✕ Свернуть</button>
    ${initialSvg}
  </div>

  <div class="legend" id="legend">
    <span><i class="sw" style="background:#161e2d;border:1px solid var(--line-light)"></i> Обычный модуль</span>
    <span><i class="sw" style="background:#261f10;border:1px solid #856417"></i> Крупный модуль (&ge;600 строк)</span>
    <span><i class="sw" style="background:#2e1215;border:1px solid var(--bad)"></i> Цикл взаимных зависимостей</span>
    <span class="muted" style="margin-left:auto;">Колёсико мыши: зум · Перетаскивание: панорама · Клик/Enter: инспектор</span>
  </div>

  <!-- Problems View Container -->
  <div id="problems-view"></div>
</div>

<h2>Сводка статического анализа</h2>
<div class="card">
  <div class="kv" style="grid-template-columns: 220px 1fr;">
    <span class="k">Движок анализа</span><span class="v">${esc(analysisEngine)}</span>
    <span class="k">Поддерживаемые форматы</span><span class="v">${esc(supportedExtText)}</span>
    <span class="k">Всего распознано символов</span><span class="v">${totalSymbols}</span>
    <span class="k">Всего разрешено вызовов</span><span class="v">${totalCalls}</span>
    <span class="k">Неразрешённых вызовов</span><span class="v">${totalUnresolved}</span>
  </div>
</div>

<h2>Динамика изменений</h2>
<div class="card">
  ${deltaBlock}
</div>

<h2>Крупнейшие модули проекта</h2>
<div class="card">
  <table>
    <thead><tr><th>Файл</th><th>Строк</th><th>Ветвлений</th><th>MI</th><th>Входящие</th><th>Исходящие</th></tr></thead>
    <tbody>
      ${topFiles.map(([p, f]) => `<tr>
        <td><code class="flink" tabindex="0" role="button" aria-label="Открыть файл ${esc(p)}" data-path="${esc(p)}">${esc(p)}</code></td>
        <td>${f.loc}</td>
        <td>${f.complexity}</td>
        <td>${f.mi}</td>
        <td>${f.fanIn}</td>
        <td>${f.fanOut}</td>
      </tr>`).join("")}
    </tbody>
  </table>
</div>

<h2>Замечания и архитектурные дефекты (${safeFindings.total || shown.length})</h2>
${shown.length
  ? `<div class="card">
      ${shown.map(findingCard).join("")}
    </div>`
  : `<div class="card"><p class="muted">Критических замечаний архитектурного характера не выявлено.</p></div>`}

</div>

<!-- Inspector Slide Panel -->
<div class="panel" id="panel" role="dialog" aria-modal="true" aria-label="Инспектор элемента">
  <button class="panel-close" id="panel-close" aria-label="Закрыть панель">&times;</button>
  <div id="panel-content"></div>
</div>

<script id="archmap-data" type="application/json">
${embedData(safeState, safeDelta, safeFindings)}
</script>

<script>
${renderClientScript()}
</script>
</body>
</html>`;
}


let cachedCss = null;
let cachedClientJs = null;

function loadCss() {
  if (cachedCss !== null) return cachedCss;
  try {
    cachedCss = fs.readFileSync(new URL("./report/page.css", import.meta.url), "utf8");
    return cachedCss;
  } catch (err) {
    throw new Error("Отсутствует tools/report/page.css — переустановите harness");
  }
}

// The client script ships as ordered real files (concatenated at render) so no
// single file crosses the giant-module threshold and each part gets real syntax
// checking. Order matters: core defines state, graphs and problems build on it.
const CLIENT_PARTS = ["client.core.js", "client.graphs.js", "client.problems.js"];

function loadClientJs() {
  if (cachedClientJs !== null) return cachedClientJs;
  const parts = CLIENT_PARTS.map((name) => {
    try {
      return fs.readFileSync(new URL(`./report/${name}`, import.meta.url), "utf8");
    } catch (err) {
      throw new Error(`Отсутствует tools/report/${name} — переустановите harness`);
    }
  });
  cachedClientJs = parts.join("\n");
  return cachedClientJs;
}

function renderClientScript() {
  const clientJs = loadClientJs();
  const declarations = [
    'const DATA = JSON.parse(document.getElementById("archmap-data").textContent);',
    'const KIND_RU = ' + JSON.stringify(KIND_RU) + ';',
    'const SEV_RU = ' + JSON.stringify(SEV_RU) + ';',
    'const SYM_KIND_RU = ' + JSON.stringify(SYM_KIND_RU) + ';',
    'const REASON_RU = ' + JSON.stringify(REASON_RU) + ';',
    'const PROBLEM_SEVERITY_RU = ' + JSON.stringify(PROBLEM_SEVERITY_RU) + ';',
    'const PROBLEM_CATEGORY_RU = ' + JSON.stringify(PROBLEM_CATEGORY_RU) + ';'
  ].join("\n");
  return clientJs.replace('/*__ARCHMAP_DATA__*/', declarations);
}
