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
  :root {
    --bg: #0b0f17;
    --card: #111827;
    --card-hover: #172033;
    --line: #1f293d;
    --line-light: #2d3b55;
    --text: #e2e8f0;
    --muted: #94a3b8;
    --accent: #38bdf8;
    --accent-hover: #0ea5e9;
    --good: #34d399;
    --fair: #fbbf24;
    --bad: #f87171;
    --critical: #ef4444;
    --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --mono: "JetBrains Mono", Consolas, "Liberation Mono", Menlo, Courier, monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    font-size: 13.5px;
    line-height: 1.5;
    padding: 24px;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1380px; margin: 0 auto; }
  header { margin-bottom: 20px; }
  h1 { font-size: 24px; font-weight: 700; color: #f8fafc; letter-spacing: -0.02em; }
  .sub { color: var(--muted); font-size: 12.5px; margin-top: 4px; }
  .card {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 16px 20px;
    margin-bottom: 20px;
  }
  .score-row {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 12px;
  }
  .score-num {
    font-size: 44px;
    font-weight: 800;
    line-height: 1;
    letter-spacing: -0.03em;
  }
  .score-meta { flex: 1; }
  .score-title { font-size: 15px; font-weight: 600; color: #f8fafc; }
  .bar {
    height: 6px;
    background: var(--line);
    border-radius: 999px;
    overflow: hidden;
    margin-top: 6px;
  }
  .bar i { display: block; height: 100%; border-radius: 999px; }
  .score-desc {
    color: var(--muted);
    font-size: 11.5px;
    margin-top: 10px;
    line-height: 1.4;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 10px;
  }
  .stat {
    background: #0d131f;
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 10px 12px;
  }
  .stat span {
    display: block;
    font-size: 18px;
    font-weight: 700;
    color: #f8fafc;
  }
  .stat label {
    font-size: 11px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .stat.up span { color: var(--good); }
  .stat.down span { color: var(--bad); }

  .graph-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
    margin-bottom: 12px;
  }
  .graph-controls {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
  }
  .btn-group {
    display: inline-flex;
    background: #090d14;
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 2px;
  }
  .btn-tab {
    background: transparent;
    border: none;
    color: var(--muted);
    font-family: inherit;
    font-size: 12.5px;
    font-weight: 500;
    padding: 6px 14px;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .btn-tab:hover { color: #f8fafc; }
  .btn-tab:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  .btn-tab.active {
    background: var(--line-light);
    color: #f8fafc;
    font-weight: 600;
  }
  .btn-tab.active[aria-pressed="true"] {
    background: var(--line-light);
    color: #f8fafc;
  }
  .graph-actions {
    display: flex;
    gap: 6px;
  }
  .btn-action {
    background: #0d131f;
    border: 1px solid var(--line);
    color: var(--text);
    font-family: inherit;
    font-size: 12px;
    padding: 6px 11px;
    border-radius: 5px;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .btn-action:hover {
    background: var(--line);
    border-color: var(--line-light);
    color: #fff;
  }
  .btn-action:focus { outline: 2px solid var(--accent); }
  .search-box {
    position: relative;
    min-width: 240px;
  }
  .search-input {
    width: 100%;
    background: #090d14;
    border: 1px solid var(--line);
    color: var(--text);
    font-family: inherit;
    font-size: 12.5px;
    padding: 6px 10px;
    border-radius: 6px;
    outline: none;
    transition: border-color 0.15s ease;
  }
  .search-input:focus {
    border-color: var(--accent);
  }
  .search-results {
    display: none;
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    background: var(--card);
    border: 1px solid var(--line-light);
    border-radius: 6px;
    margin-top: 4px;
    max-height: 280px;
    overflow-y: auto;
    z-index: 100;
    box-shadow: 0 10px 25px rgba(0,0,0,0.5);
  }
  .search-results.open { display: block; }
  .search-item {
    padding: 8px 12px;
    font-size: 12px;
    cursor: pointer;
    border-bottom: 1px solid var(--line);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .search-item:last-child { border-bottom: none; }
  .search-item:hover, .search-item:focus {
    background: var(--line);
    outline: none;
  }
  .search-item .tag {
    font-size: 10px;
    text-transform: uppercase;
    padding: 2px 6px;
    border-radius: 4px;
    background: #090d14;
    color: var(--muted);
  }

  .graphwrap {
    position: relative;
    width: 100%;
    height: 560px;
    background: #080c14;
    border: 1px solid var(--line);
    border-radius: 6px;
    overflow: hidden;
  }
  .graphwrap.fullscreen {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    z-index: 9999;
    border-radius: 0;
    border: none;
  }
  .fullscreen-exit {
    display: none;
    position: absolute;
    top: 14px;
    right: 14px;
    z-index: 10;
    background: rgba(15, 23, 42, 0.9);
    border: 1px solid var(--line-light);
    color: var(--text);
    padding: 6px 12px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
  }
  .graphwrap.fullscreen .fullscreen-exit { display: block; }
  svg#graph {
    width: 100%;
    height: 100%;
    display: block;
    user-select: none;
  }
  .legend {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-top: 10px;
    font-size: 11.5px;
    color: var(--muted);
    flex-wrap: wrap;
  }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .sw { display: inline-block; width: 12px; height: 12px; border-radius: 3px; }

  /* SVG Graph elements */
  .edge {
    fill: none;
    stroke: #252e40;
    stroke-width: 1.4;
    transition: stroke 0.15s, stroke-width 0.15s;
  }
  .edge.edge-cycle {
    stroke: #80272b;
    stroke-width: 1.8;
  }
  .edge.active {
    stroke: var(--accent);
    stroke-width: 2.2;
  }
  .node {
    cursor: pointer;
    transition: opacity 0.15s;
  }
  .node rect {
    stroke-width: 1;
    transition: all 0.15s;
  }
  .node.nrm rect { fill: #111827; stroke: #252e40; }
  .node.big rect { fill: #201a11; stroke: #6e4e14; }
  .node.cyc rect { fill: #261215; stroke: #78292d; }
  .node.hub rect { fill: #162438; stroke: #1e3a8a; }
  .node.node-cluster rect { fill: #162033; stroke: #3b82f6; stroke-width: 1.5; stroke-dasharray: 4 2; }
  .node.node-cluster:hover rect { fill: #1e293b; stroke: #60a5fa; }
  .node.node-file-center rect { fill: #1e293b; stroke: var(--accent); stroke-width: 2; }
  .node.node-dep rect { fill: #141f2d; stroke: #334155; }
  .node.node-user rect { fill: #1f1b2e; stroke: #475569; }
  .node.node-symbol-local rect { fill: #0f172a; stroke: #38bdf8; stroke-width: 1; }
  .node:hover rect, .node:focus rect {
    stroke: var(--accent);
    stroke-width: 2;
  }
  .node.selected rect {
    stroke: #38bdf8;
    stroke-width: 2.2;
    fill: #1a2538;
  }
  .node.dimmed {
    opacity: 0.18;
  }
  .nt {
    font-family: var(--mono);
    font-size: 11.5px;
    fill: #f1f5f9;
  }
  .nl {
    font-family: var(--mono);
    font-size: 10px;
    fill: var(--muted);
  }

  /* Problems View Container */
  #problems-view {
    display: none;
    padding-top: 4px;
  }
  .prob-filters {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
    margin-bottom: 16px;
  }
  .prob-chip {
    background: #090d14;
    border: 1px solid var(--line);
    color: var(--muted);
    font-size: 12px;
    padding: 5px 12px;
    border-radius: 999px;
    cursor: pointer;
    transition: all 0.15s;
    user-select: none;
  }
  .prob-chip:hover { color: #f8fafc; border-color: var(--line-light); }
  .prob-chip.active {
    background: var(--line-light);
    color: #fff;
    border-color: var(--accent);
    font-weight: 600;
  }
  .prob-group {
    margin-bottom: 24px;
  }
  .prob-group-title {
    font-size: 14px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .prob-group-title.critical { color: var(--critical); }
  .prob-group-title.high { color: var(--bad); }
  .prob-group-title.medium { color: var(--fair); }
  .prob-group-title.low { color: var(--accent); }

  .prob-card {
    background: #0d131f;
    border: 1px solid var(--line);
    border-left: 4px solid var(--line-light);
    border-radius: 6px;
    padding: 14px 16px;
    margin-bottom: 12px;
    transition: border-color 0.15s;
  }
  .prob-card:hover {
    border-color: var(--line-light);
  }
  .prob-card.critical { border-left-color: var(--critical); }
  .prob-card.high { border-left-color: var(--bad); }
  .prob-card.medium { border-left-color: var(--fair); }
  .prob-card.low { border-left-color: var(--accent); }

  .prob-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
    flex-wrap: wrap;
  }
  .prob-badges {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .badge-sev {
    font-size: 10.5px;
    font-weight: 700;
    text-transform: uppercase;
    padding: 2px 7px;
    border-radius: 4px;
  }
  .badge-sev.critical { background: #451a1a; color: #fca5a5; border: 1px solid #7f1d1d; }
  .badge-sev.high { background: #381a18; color: #fca5a5; border: 1px solid #7f1d1d; }
  .badge-sev.medium { background: #35260f; color: #fde047; border: 1px solid #713f12; }
  .badge-sev.low { background: #11263c; color: #7dd3fc; border: 1px solid #075985; }

  .badge-cat {
    font-size: 10.5px;
    font-weight: 500;
    background: #090d14;
    color: var(--muted);
    border: 1px solid var(--line);
    padding: 2px 7px;
    border-radius: 4px;
  }
  .prob-title {
    font-size: 14.5px;
    font-weight: 600;
    color: #f8fafc;
    margin-bottom: 6px;
  }
  .prob-why {
    color: #cbd5e1;
    font-size: 13px;
    margin-bottom: 6px;
  }
  .prob-fix {
    color: var(--muted);
    font-size: 12.5px;
    margin-bottom: 10px;
    padding-left: 10px;
    border-left: 2px solid var(--line-light);
  }
  .prob-fix b { color: #e2e8f0; }
  .prob-locations {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-bottom: 10px;
  }
  .loc-chip {
    font-family: var(--mono);
    font-size: 11.5px;
    background: #090d14;
    border: 1px solid var(--line);
    color: var(--accent);
    padding: 3px 8px;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .loc-chip:hover {
    border-color: var(--accent);
    background: #111e33;
  }
  .btn-copy-prompt {
    background: #162238;
    border: 1px solid #23385d;
    color: #93c5fd;
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    padding: 6px 12px;
    border-radius: 5px;
    cursor: pointer;
    transition: all 0.15s ease;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .btn-copy-prompt:hover {
    background: #1e3a8a;
    color: #fff;
    border-color: #3b82f6;
  }
  .btn-copy-prompt.copied {
    background: #064e3b;
    color: #6ee7b7;
    border-color: #059669;
  }

  /* Inspector side panel */
  .panel {
    display: none;
    position: fixed;
    top: 0;
    right: 0;
    width: 440px;
    max-width: 90vw;
    height: 100vh;
    background: #0d131f;
    border-left: 1px solid var(--line-light);
    box-shadow: -10px 0 30px rgba(0,0,0,0.6);
    z-index: 10000;
    padding: 24px;
    overflow-y: auto;
  }
  .panel.open { display: block; }
  .panel-close {
    position: absolute;
    top: 18px;
    right: 18px;
    background: transparent;
    border: none;
    color: var(--muted);
    font-size: 20px;
    cursor: pointer;
    padding: 4px 8px;
  }
  .panel-close:hover { color: #fff; }
  .panel h3 {
    font-size: 13px;
    text-transform: uppercase;
    color: var(--muted);
    margin-top: 18px;
    margin-bottom: 6px;
    letter-spacing: 0.05em;
  }
  .panel h3:first-of-type { margin-top: 0; }
  .kv {
    display: grid;
    grid-template-columns: 140px 1fr;
    gap: 6px;
    font-size: 12.5px;
    margin-bottom: 12px;
  }
  .kv .k { color: var(--muted); }
  .kv .v { font-family: var(--mono); color: #f8fafc; font-weight: 500; }
  .plist {
    list-style: none;
    font-size: 12px;
    font-family: var(--mono);
  }
  .plist li {
    padding: 4px 0;
    border-bottom: 1px solid #141b2b;
    word-break: break-all;
  }
  .plist li:last-child { border-bottom: none; }
  .plist code.jump {
    color: var(--accent);
    cursor: pointer;
    text-decoration: underline;
  }
  .plist code.jump:hover { color: #fff; }

  /* Findings list styles */
  .finding {
    padding: 12px 14px;
    border-radius: 6px;
    background: #090d14;
    border: 1px solid var(--line);
    border-left: 4px solid var(--line-light);
    margin-bottom: 10px;
  }
  .finding.high { border-left-color: var(--bad); }
  .finding.medium { border-left-color: var(--fair); }
  .finding.low { border-left-color: var(--accent); }
  .fhead {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
    flex-wrap: wrap;
  }
  .sev {
    font-size: 10px;
    text-transform: uppercase;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: 4px;
  }
  .sev.high { background: #381a18; color: #fca5a5; }
  .sev.medium { background: #35260f; color: #fde047; }
  .sev.low { background: #11263c; color: #7dd3fc; }
  .fkind {
    font-size: 11px;
    color: var(--muted);
    font-family: var(--mono);
  }
  .where {
    margin-bottom: 6px;
    font-family: var(--mono);
    font-size: 11.5px;
  }
  .where code.flink {
    background: #162032;
    padding: 2px 6px;
    border-radius: 4px;
    color: var(--accent);
    cursor: pointer;
  }
  .where code.flink:hover {
    background: var(--line-light);
  }
  .why {
    color: #cbd5e1;
    font-size: 12.5px;
    margin-bottom: 4px;
  }
  .fix {
    color: var(--muted);
    font-size: 12px;
  }
  .cyclewarn {
    background: #2b1115;
    border: 1px solid #7f1d1d;
    padding: 10px 14px;
    border-radius: 6px;
    color: #fca5a5;
    margin-bottom: 14px;
    font-size: 12.5px;
  }
  .cyclewarn ul { margin-left: 18px; margin-top: 4px; font-family: var(--mono); font-size: 12px; }

  /* Call items inside inspector */
  .call-item {
    background: #090d14;
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 6px 8px;
    margin-bottom: 4px;
    font-size: 11.5px;
    font-family: var(--mono);
  }
  .call-expr { color: #f1f5f9; }
  .call-reason { color: var(--muted); font-size: 11px; font-family: var(--font); margin-top: 2px; }

  /* Section heading */
  h2 {
    font-size: 17px;
    font-weight: 600;
    color: #f8fafc;
    margin-top: 24px;
    margin-bottom: 12px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12.5px;
    font-family: var(--mono);
  }
  th, td {
    padding: 8px 10px;
    text-align: left;
    border-bottom: 1px solid var(--line);
  }
  th { color: var(--muted); font-size: 11px; text-transform: uppercase; font-family: var(--font); }
  tr:hover td { background: #0e1626; }
  td.bad { color: var(--bad); }
  td.good { color: var(--good); }

  @media (max-width: 768px) {
    body { padding: 12px; }
    .panel { width: 100vw; }
    .graphwrap { height: 420px; }
    .graph-toolbar { flex-direction: column; align-items: stretch; }
    .graph-controls { justify-content: space-between; }
    .btn-group { width: 100%; }
    .btn-tab { flex: 1; text-align: center; padding: 6px 8px; font-size: 11.5px; }
    .search-box { width: 100%; min-width: 100%; }
    .score-row { flex-direction: column; align-items: flex-start; gap: 8px; }
    table { display: block; overflow-x: auto; max-width: 100%; white-space: nowrap; }
  }
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
const DATA = JSON.parse(document.getElementById("archmap-data").textContent);
const KIND_RU = ${JSON.stringify(KIND_RU)};
const SEV_RU = ${JSON.stringify(SEV_RU)};
const SYM_KIND_RU = ${JSON.stringify(SYM_KIND_RU)};
const REASON_RU = ${JSON.stringify(REASON_RU)};
const PROBLEM_SEVERITY_RU = ${JSON.stringify(PROBLEM_SEVERITY_RU)};
const PROBLEM_CATEGORY_RU = ${JSON.stringify(PROBLEM_CATEGORY_RU)};
const FILE_KEYS = Object.keys(DATA.files || {});
const TOTAL_FILES_COUNT = FILE_KEYS.length;

/* Global state */
let currentMode = "modules"; // "modules" | "calls" | "problems" | "file"
let savedViewState = null;
let currentTargetFile = null;
let callsFilterConnectedOnly = false;
let clusterMode = TOTAL_FILES_COUNT > 40;
const expandedClusters = new Set();
let activeProblemCategory = "all";

/* Precompute graph indices */
const USERS = {};
for (const [p, f] of Object.entries(DATA.files)) {
  for (const dep of (f.deps || [])) {
    if (!USERS[dep]) USERS[dep] = [];
    USERS[dep].push(p);
  }
}

const SYMBOLS_BY_ID = new Map();
const SYMBOLS_BY_FILE = new Map();
(DATA.symbols || []).forEach((s) => {
  SYMBOLS_BY_ID.set(s.id, s);
  if (!SYMBOLS_BY_FILE.has(s.file)) SYMBOLS_BY_FILE.set(s.file, []);
  SYMBOLS_BY_FILE.get(s.file).push(s);
});

const CALLERS_BY_SYM = new Map();
const CALLEES_BY_SYM = new Map();
(DATA.calls || []).forEach((c) => {
  if (!CALLERS_BY_SYM.has(c.to)) CALLERS_BY_SYM.set(c.to, []);
  CALLERS_BY_SYM.get(c.to).push(c);
  if (!CALLEES_BY_SYM.has(c.from)) CALLEES_BY_SYM.set(c.from, []);
  CALLEES_BY_SYM.get(c.from).push(c);
});

const UNRESOLVED_BY_SYM = new Map();
(DATA.unresolvedCalls || []).forEach((u) => {
  if (!UNRESOLVED_BY_SYM.has(u.caller)) UNRESOLVED_BY_SYM.set(u.caller, []);
  UNRESOLVED_BY_SYM.get(u.caller).push(u);
});

const CYCLE_MAP = new Map();
(DATA.cycles || []).forEach((comp, idx) => {
  if (Array.isArray(comp)) {
    for (const node of comp) {
      if (!CYCLE_MAP.has(node)) CYCLE_MAP.set(node, new Set());
      CYCLE_MAP.get(node).add(idx);
    }
  }
});

/* DOM references */
const svg = document.getElementById("graph");
const viewport = document.getElementById("viewport");
const edgeLayer = document.getElementById("edge-layer");
const nodeLayer = document.getElementById("node-layer");
const gw = document.getElementById("gw");
const legend = document.getElementById("legend");
const panel = document.getElementById("panel");
const panelContent = document.getElementById("panel-content");
const panelClose = document.getElementById("panel-close");
const searchInput = document.getElementById("search-input");
const searchResults = document.getElementById("search-results");
const problemsView = document.getElementById("problems-view");
const btnModules = document.getElementById("tab-modules");
const btnCalls = document.getElementById("tab-calls");
const btnProblems = document.getElementById("tab-problems");
const btnConnectedFilter = document.getElementById("btn-connected-filter");
const btnClusterToggle = document.getElementById("btn-cluster-toggle");
const btnBackToMap = document.getElementById("btn-back-to-map");
const btnFit = document.getElementById("btn-fit");
const btnFs = document.getElementById("btn-fs");
const btnExitFs = document.getElementById("btn-exit-fs");

let selectedId = null;
let selectedType = null; // "module" | "symbol" | "cluster"

/* Pan & Zoom State */
let isPanning = false;
let startX = 0, startY = 0;
let tx = 0, ty = 0, k = 1;

function applyTransform() {
  viewport.setAttribute("transform", "translate(" + tx + "," + ty + ") scale(" + k + ")");
}

function fitGraph() {
  const vb = svg.viewBox.baseVal;
  if (!vb || !vb.width || !vb.height) return;
  const rect = gw.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const kx = (rect.width - 60) / vb.width;
  const ky = (rect.height - 60) / vb.height;
  k = Math.min(kx, ky, 1.25);
  tx = (rect.width - vb.width * k) / 2;
  ty = (rect.height - vb.height * k) / 2;
  applyTransform();
}

gw.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || currentMode === "problems") return;
  if (e.target.closest(".node") || e.target.closest("button")) return;
  isPanning = true;
  startX = e.clientX - tx;
  startY = e.clientY - ty;
  gw.style.cursor = "grabbing";
});

window.addEventListener("mousemove", (e) => {
  if (!isPanning) return;
  tx = e.clientX - startX;
  ty = e.clientY - startY;
  applyTransform();
});

window.addEventListener("mouseup", () => {
  if (isPanning) {
    isPanning = false;
    gw.style.cursor = "default";
  }
});

gw.addEventListener("wheel", (e) => {
  if (currentMode === "problems") return;
  e.preventDefault();
  const rect = gw.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const factor = e.deltaY < 0 ? 1.15 : 0.87;
  const newK = Math.max(0.1, Math.min(5, k * factor));
  tx = mx - (mx - tx) * (newK / k);
  ty = my - (my - ty) * (newK / k);
  k = newK;
  applyTransform();
}, { passive: false });

/* Fullscreen toggle */
function toggleFullscreen(on) {
  const willFs = on !== undefined ? on : !gw.classList.contains("fullscreen");
  if (willFs) {
    gw.classList.add("fullscreen");
  } else {
    gw.classList.remove("fullscreen");
  }
  setTimeout(fitGraph, 40);
}
btnFs.addEventListener("click", () => toggleFullscreen(true));
btnExitFs.addEventListener("click", () => toggleFullscreen(false));
btnFit.addEventListener("click", fitGraph);

function escHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

/* Clipboard Copy with execCommand fallback for file:// */
async function copyPromptToClipboard(text, btn) {
  let ok = false;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {
      ok = false;
    }
  }
  if (!ok) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      ta.style.top = "-9999px";
      ta.setAttribute("readonly", "");
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ok = document.execCommand("copy");
      document.body.removeChild(ta);
    } catch (e) {
      ok = false;
    }
  }

  if (btn) {
    const orig = btn.textContent;
    btn.textContent = ok ? "Скопировано!" : "Ошибка копирования";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = orig;
      btn.classList.remove("copied");
    }, 1500);
  }
}

/* Top folder helper */
function getFileTopFolder(p) {
  const norm = String(p || "").replace(/\\\\/g, "/");
  const parts = norm.split("/");
  if (parts.length > 1) return parts[0];
  return "(корень)";
}

/* Cluster Toggle button handler */
function toggleAllClusters() {
  const folders = new Set();
  for (const p of FILE_KEYS) {
    folders.add(getFileTopFolder(p));
  }
  if (expandedClusters.size < folders.size) {
    for (const f of folders) expandedClusters.add(f);
    btnClusterToggle.textContent = "Свернуть всё";
  } else {
    expandedClusters.clear();
    btnClusterToggle.textContent = "Развернуть всё";
  }
  renderModulesMode();
  fitGraph();
}
btnClusterToggle.addEventListener("click", toggleAllClusters);

/* Back to Map button handler */
btnBackToMap.addEventListener("click", () => {
  if (savedViewState) {
    const prev = savedViewState;
    setMode(prev.mode);
    tx = prev.tx; ty = prev.ty; k = prev.k;
    applyTransform();
    if (prev.selectedId) {
      if (prev.selectedType === "module") selectModule(prev.selectedId);
      else if (prev.selectedType === "symbol") selectSymbol(prev.selectedId);
    }
    savedViewState = null;
  } else {
    setMode("modules");
    fitGraph();
  }
});

/* View switching */
function setMode(mode) {
  currentMode = mode;

  // Update tabs state
  const tabs = [
    { btn: btnModules, id: "modules" },
    { btn: btnCalls, id: "calls" },
    { btn: btnProblems, id: "problems" }
  ];

  tabs.forEach((t) => {
    const isActive = (t.id === mode || (mode === "file" && t.id === "modules"));
    t.btn.classList.toggle("active", isActive);
    t.btn.setAttribute("aria-selected", isActive ? "true" : "false");
    t.btn.setAttribute("aria-pressed", isActive ? "true" : "false");
    t.btn.setAttribute("tabindex", isActive ? "0" : "-1");
  });

  // Action button visibilities
  btnConnectedFilter.style.display = (mode === "calls") ? "inline-block" : "none";
  btnClusterToggle.style.display = (mode === "modules" && TOTAL_FILES_COUNT > 40) ? "inline-block" : "none";
  btnBackToMap.style.display = (mode === "file") ? "inline-block" : "none";
  btnFit.style.display = (mode !== "problems") ? "inline-block" : "none";
  btnFs.style.display = (mode !== "problems") ? "inline-block" : "none";

  if (mode === "problems") {
    gw.style.display = "none";
    legend.style.display = "none";
    problemsView.style.display = "block";
    renderProblemsMode();
    return;
  }

  gw.style.display = "block";
  legend.style.display = "flex";
  problemsView.style.display = "none";

  if (mode === "modules") {
    renderModulesMode();
    updateLegend("modules");
    fitGraph();
  } else if (mode === "calls") {
    renderCallsMode();
    updateLegend("calls");
    fitGraph();
  } else if (mode === "file") {
    renderFileLocalGraph(currentTargetFile);
    updateLegend("file");
    fitGraph();
  }
}

btnModules.addEventListener("click", () => setMode("modules"));
btnCalls.addEventListener("click", () => setMode("calls"));
btnProblems.addEventListener("click", () => setMode("problems"));

/* Tablist keyboard navigation */
const viewTabsContainer = document.getElementById("view-tabs");
viewTabsContainer.addEventListener("keydown", (e) => {
  const tabs = [btnModules, btnCalls, btnProblems];
  const idx = tabs.indexOf(document.activeElement);
  if (idx === -1) return;

  let nextIdx = idx;
  if (e.key === "ArrowRight") {
    nextIdx = (idx + 1) % tabs.length;
  } else if (e.key === "ArrowLeft") {
    nextIdx = (idx - 1 + tabs.length) % tabs.length;
  } else if (e.key === "Home") {
    nextIdx = 0;
  } else if (e.key === "End") {
    nextIdx = tabs.length - 1;
  } else if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    tabs[idx].click();
    return;
  } else {
    return;
  }

  e.preventDefault();
  tabs[nextIdx].focus();
  tabs[nextIdx].click();
});

btnConnectedFilter.addEventListener("click", () => {
  callsFilterConnectedOnly = !callsFilterConnectedOnly;
  btnConnectedFilter.textContent = callsFilterConnectedOnly ? "Только связанные" : "Все символы";
  renderCallsMode();
  fitGraph();
});

function updateLegend(mode) {
  if (mode === "modules") {
    legend.innerHTML =
      '<span><i class="sw" style="background:#161e2d;border:1px solid var(--line-light)"></i> Обычный модуль</span>' +
      '<span><i class="sw" style="background:#261f10;border:1px solid #856417"></i> Крупный модуль (&ge;600 строк)</span>' +
      '<span><i class="sw" style="background:#2e1215;border:1px solid var(--bad)"></i> Цикл взаимных зависимостей</span>' +
      (TOTAL_FILES_COUNT > 40 ? '<span><i class="sw" style="background:#162033;border:1px dashed #3b82f6"></i> Папка-кластер</span>' : '') +
      '<span class="muted" style="margin-left:auto;">Колёсико мыши: зум · Перетаскивание: панорама · Клик/Enter: инспектор</span>';
  } else if (mode === "calls") {
    legend.innerHTML =
      '<span><i class="sw" style="background:#101927;border:1px solid #38bdf8"></i> Функция / метод</span>' +
      '<span><i class="sw" style="background:#241c2c;border:1px solid #c084fc"></i> Внешний / хаб</span>' +
      '<span><i class="sw" style="background:#1c1e24;border:1px dashed #64748b"></i> Изолированный символ</span>' +
      '<span class="muted" style="margin-left:auto;">Стрелка: прямой вызов функции · Зелёный: caller, Жёлтый: callee</span>';
  } else if (mode === "file") {
    legend.innerHTML =
      '<span><i class="sw" style="background:#1e293b;border:2px solid var(--accent)"></i> Текущий файл</span>' +
      '<span><i class="sw" style="background:#141f2d;border:1px solid #334155"></i> Импортирует (слева)</span>' +
      '<span><i class="sw" style="background:#1f1b2e;border:1px solid #475569"></i> Импортируется (справа)</span>' +
      '<span><i class="sw" style="background:#0f172a;border:1px solid #38bdf8"></i> Символы и вызовы файла (внизу)</span>' +
      '<span class="muted" style="margin-left:auto;">Кнопка «← К карте» возвращает в предыдущий вид</span>';
  }
}

/* Render Modules Mode (Flat or Folder Clusters) */
function renderModulesMode() {
  const filesList = Object.entries(DATA.files);
  const useClusters = TOTAL_FILES_COUNT > 40;

  if (!useClusters) {
    // Standard flat module layout
    const files = Object.keys(DATA.files);
    const depth = new Map();
    const compute = (p, seen = new Set()) => {
      if (depth.has(p)) return depth.get(p);
      if (seen.has(p)) return 0;
      seen.add(p);
      const deps = (DATA.files[p] && DATA.files[p].deps) || [];
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
        });
      });
      currentColOffset += numSubCols;
    }
    const width = Math.max(700, padX * 2 + currentColOffset * colW);
    const height = Math.max(400, padY + maxVirtualRows * rowH + 60);

    svg.setAttribute("viewBox", "0 0 " + width + " " + height);

    const nodeW = 200, nodeH = 26;
    const edgeHtml = [];
    for (const [p, f] of filesList) {
      for (const dep of (f.deps || [])) {
        const a = pos.get(p), b = pos.get(dep);
        if (!a || !b) continue;
        const x1 = a.x + nodeW, y1 = a.y + nodeH / 2;
        const x2 = b.x, y2 = b.y + nodeH / 2;
        const mx = (x1 + x2) / 2;
        const inCycle = CYCLE_MAP.has(p) && CYCLE_MAP.has(dep);
        edgeHtml.push(
          '<path class="edge' + (inCycle ? ' edge-cycle' : '') + '" data-from="' + escHtml(p) + '" data-to="' + escHtml(dep) + '" d="M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2 + '" marker-end="url(#' + (inCycle ? 'arrow-cycle' : 'arrow') + ')"/>'
        );
      }
    }
    edgeLayer.innerHTML = edgeHtml.join("\\n");

    const nodeHtml = [];
    for (const [p, f] of filesList) {
      const coords = pos.get(p);
      if (!coords) continue;
      const { x, y } = coords;
      const inCycle = CYCLE_MAP.has(p);
      const big = f.loc >= 600;
      const cls = inCycle ? "cyc" : big ? "big" : "nrm";
      const label = p.length > 27 ? "…" + p.slice(-26) : p;
      nodeHtml.push(
        '<g class="node node-module ' + cls + '" tabindex="0" role="button" aria-label="Модуль ' + escHtml(p) + '" data-id="' + escHtml(p) + '" data-path="' + escHtml(p) + '" transform="translate(' + x + ',' + y + ')">' +
        '<rect width="' + nodeW + '" height="' + nodeH + '" rx="6"/>' +
        '<text class="nt" x="9" y="17">' + escHtml(label) + '</text>' +
        '<text class="nl" x="' + (nodeW - 9) + '" y="17" text-anchor="end">' + f.loc + ' стр</text>' +
        '</g>'
      );
    }
    nodeLayer.innerHTML = nodeHtml.join("\\n");
    return;
  }

  // Clustered folder view:
  // Visible items are either cluster node (for collapsed folder) or individual file nodes (for expanded folder)
  const folders = new Map();
  for (const [p, f] of filesList) {
    const fld = getFileTopFolder(p);
    if (!folders.has(fld)) folders.set(fld, { count: 0, loc: 0, files: [] });
    const rec = folders.get(fld);
    rec.count++;
    rec.loc += (f.loc || 0);
    rec.files.push(p);
  }

  // Determine active visible nodes and their connections
  const visibleNodes = [];
  const folderKeyList = [...folders.keys()].sort();

  for (const fld of folderKeyList) {
    const rec = folders.get(fld);
    if (expandedClusters.has(fld)) {
      for (const p of rec.files) {
        visibleNodes.push({ id: p, type: "file", folder: fld, fileData: DATA.files[p] });
      }
    } else {
      visibleNodes.push({ id: "cluster:" + fld, type: "cluster", folder: fld, rec });
    }
  }

  // Active edges between visible nodes
  const edgeSet = new Set();
  const activeEdges = [];

  for (const [p, f] of filesList) {
    const fromId = expandedClusters.has(getFileTopFolder(p)) ? p : "cluster:" + getFileTopFolder(p);
    for (const dep of (f.deps || [])) {
      const toId = expandedClusters.has(getFileTopFolder(dep)) ? dep : "cluster:" + getFileTopFolder(dep);
      if (fromId !== toId) {
        const edgeKey = fromId + "-->" + toId;
        if (!edgeSet.has(edgeKey)) {
          edgeSet.add(edgeKey);
          const inCycle = (CYCLE_MAP.has(p) && CYCLE_MAP.has(dep));
          activeEdges.push({ from: fromId, to: toId, inCycle });
        }
      }
    }
  }

  // Compute depth for layered topological layout of active nodes
  const nodeDeps = new Map();
  visibleNodes.forEach((n) => nodeDeps.set(n.id, []));
  activeEdges.forEach((e) => {
    if (nodeDeps.has(e.from)) nodeDeps.get(e.from).push(e.to);
  });

  const depth = new Map();
  const computeDepth = (id, seen = new Set()) => {
    if (depth.has(id)) return depth.get(id);
    if (seen.has(id)) return 0;
    seen.add(id);
    const deps = nodeDeps.get(id) || [];
    const d = deps.length ? 1 + Math.max(0, ...deps.map((x) => computeDepth(x, seen))) : 0;
    depth.set(id, d);
    return d;
  };
  visibleNodes.forEach((n) => computeDepth(n.id));

  const layers = new Map();
  visibleNodes.forEach((n) => {
    const d = depth.get(n.id) || 0;
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d).push(n);
  });

  const maxDepth = Math.max(0, ...[...layers.keys()]);
  const colW = 280, rowH = 50, padX = 40, padY = 50;
  const pos = new Map();
  const maxLayerRows = 20;
  let maxVirtualRows = 0;
  let currentColOffset = 0;

  for (let d = maxDepth; d >= 0; d--) {
    const list = layers.get(d) || [];
    list.sort((a, b) => a.id.localeCompare(b.id));
    const numSubCols = Math.max(1, Math.ceil(list.length / maxLayerRows));
    const effectiveRows = Math.min(list.length, maxLayerRows);
    maxVirtualRows = Math.max(maxVirtualRows, effectiveRows);
    list.forEach((n, i) => {
      const subCol = Math.floor(i / maxLayerRows);
      const subRow = i % maxLayerRows;
      pos.set(n.id, {
        x: padX + (currentColOffset + subCol) * colW,
        y: padY + subRow * rowH,
        node: n,
      });
    });
    currentColOffset += numSubCols;
  }

  const width = Math.max(760, padX * 2 + currentColOffset * colW);
  const height = Math.max(460, padY + maxVirtualRows * rowH + 60);
  svg.setAttribute("viewBox", "0 0 " + width + " " + height);

  // Draw edges
  const edgeHtml = [];
  activeEdges.forEach((e) => {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) return;
    const aW = a.node.type === "cluster" ? 230 : 200;
    const aH = a.node.type === "cluster" ? 38 : 26;
    const bH = b.node.type === "cluster" ? 38 : 26;
    const x1 = a.x + aW, y1 = a.y + aH / 2;
    const x2 = b.x, y2 = b.y + bH / 2;
    const mx = (x1 + x2) / 2;
    edgeHtml.push(
      '<path class="edge' + (e.inCycle ? ' edge-cycle' : '') + '" data-from="' + escHtml(e.from) + '" data-to="' + escHtml(e.to) + '" d="M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2 + '" marker-end="url(#' + (e.inCycle ? 'arrow-cycle' : 'arrow') + ')"/>'
    );
  });
  edgeLayer.innerHTML = edgeHtml.join("\\n");

  // Draw nodes
  const nodeHtml = [];
  pos.forEach((coords, id) => {
    const { x, y, node } = coords;
    if (node.type === "cluster") {
      const cW = 230, cH = 38;
      nodeHtml.push(
        '<g class="node node-cluster" tabindex="0" role="button" aria-label="Папка ' + escHtml(node.folder) + ', ' + node.rec.count + ' файлов" data-id="' + escHtml(id) + '" data-folder="' + escHtml(node.folder) + '" transform="translate(' + x + ',' + y + ')">' +
        '<rect width="' + cW + '" height="' + cH + '" rx="8"/>' +
        '<text class="nt" x="12" y="19">📁 ' + escHtml(node.folder) + '/</text>' +
        '<text class="nl" x="' + (cW - 12) + '" y="19" text-anchor="end">' + node.rec.count + ' файлов</text>' +
        '<text class="muted" x="12" y="32" style="font-size:10px">' + node.rec.loc + ' строк кода · клик: развернуть</text>' +
        '</g>'
      );
    } else {
      const nW = 200, nH = 26;
      const p = node.id;
      const f = node.fileData;
      const inCycle = CYCLE_MAP.has(p);
      const big = f.loc >= 600;
      const cls = inCycle ? "cyc" : big ? "big" : "nrm";
      const label = p.length > 27 ? "…" + p.slice(-26) : p;
      nodeHtml.push(
        '<g class="node node-module ' + cls + '" tabindex="0" role="button" aria-label="Модуль ' + escHtml(p) + '" data-id="' + escHtml(p) + '" data-path="' + escHtml(p) + '" transform="translate(' + x + ',' + y + ')">' +
        '<rect width="' + nW + '" height="' + nH + '" rx="6"/>' +
        '<text class="nt" x="9" y="17">' + escHtml(label) + '</text>' +
        '<text class="nl" x="' + (nW - 9) + '" y="17" text-anchor="end">' + f.loc + ' стр</text>' +
        '</g>'
      );
    }
  });
  nodeLayer.innerHTML = nodeHtml.join("\\n");
}

/* Render Function Calls Graph Mode */
function renderCallsMode() {
  const allSymbols = DATA.symbols || [];
  if (!allSymbols.length) {
    edgeLayer.innerHTML = "";
    nodeLayer.innerHTML = '<text x="100" y="100" fill="#94a3b8" font-size="14">Символы не обнаружены в проекте</text>';
    return;
  }

  const connectedSet = new Set();
  (DATA.calls || []).forEach((c) => {
    connectedSet.add(c.from);
    connectedSet.add(c.to);
  });

  const visibleSymbols = callsFilterConnectedOnly
    ? allSymbols.filter((s) => connectedSet.has(s.id))
    : allSymbols;

  if (!visibleSymbols.length) {
    edgeLayer.innerHTML = "";
    nodeLayer.innerHTML = '<text x="100" y="100" fill="#94a3b8" font-size="14">Связанные вызовы функций отсутствуют</text>';
    return;
  }

  const nodeMap = new Map();
  visibleSymbols.forEach((s) => nodeMap.set(s.id, s));

  const depth = new Map();
  const computeDepth = (id, seen = new Set()) => {
    if (depth.has(id)) return depth.get(id);
    if (seen.has(id)) return 0;
    seen.add(id);
    const callees = CALLEES_BY_SYM.get(id) || [];
    const valid = callees.filter((c) => nodeMap.has(c.to));
    const d = valid.length ? 1 + Math.max(0, ...valid.map((c) => computeDepth(c.to, seen))) : 0;
    depth.set(id, d);
    return d;
  };
  visibleSymbols.forEach((s) => computeDepth(s.id));

  const layers = new Map();
  visibleSymbols.forEach((s) => {
    const d = depth.get(s.id) || 0;
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d).push(s);
  });

  const maxDepth = Math.max(0, ...[...layers.keys()]);
  const colW = 280, rowH = 46, padX = 40, padY = 50;
  const pos = new Map();
  const maxLayerRows = 25;
  let maxVirtualRows = 0;
  let currentColOffset = 0;

  for (let d = maxDepth; d >= 0; d--) {
    const list = layers.get(d) || [];
    list.sort((a, b) => a.name.localeCompare(b.name));
    const numSubCols = Math.max(1, Math.ceil(list.length / maxLayerRows));
    const effectiveRows = Math.min(list.length, maxLayerRows);
    maxVirtualRows = Math.max(maxVirtualRows, effectiveRows);
    list.forEach((s, i) => {
      const subCol = Math.floor(i / maxLayerRows);
      const subRow = i % maxLayerRows;
      pos.set(s.id, {
        x: padX + (currentColOffset + subCol) * colW,
        y: padY + subRow * rowH,
      });
    });
    currentColOffset += numSubCols;
  }

  const width = Math.max(760, padX * 2 + currentColOffset * colW);
  const height = Math.max(460, padY + maxVirtualRows * rowH + 60);
  svg.setAttribute("viewBox", "0 0 " + width + " " + height);

  const nodeW = 220, nodeH = 30;
  const edgeHtml = [];
  (DATA.calls || []).forEach((c) => {
    const a = pos.get(c.from), b = pos.get(c.to);
    if (!a || !b) return;
    const x1 = a.x + nodeW, y1 = a.y + nodeH / 2;
    const x2 = b.x, y2 = b.y + nodeH / 2;
    const mx = (x1 + x2) / 2;
    edgeHtml.push(
      '<path class="edge" data-from="' + escHtml(c.from) + '" data-to="' + escHtml(c.to) + '" d="M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2 + '" marker-end="url(#arrow)"/>'
    );
  });
  edgeLayer.innerHTML = edgeHtml.join("\\n");

  const nodeHtml = [];
  visibleSymbols.forEach((s) => {
    const coords = pos.get(s.id);
    if (!coords) return;
    const { x, y } = coords;
    const callers = CALLERS_BY_SYM.get(s.id) || [];
    const callees = CALLEES_BY_SYM.get(s.id) || [];
    const isHub = (callers.length + callees.length) >= 6;
    const isIsolated = callers.length === 0 && callees.length === 0;
    const cls = isHub ? "hub" : isIsolated ? "nrm dimmed" : "nrm";
    const label = s.name.length > 20 ? s.name.slice(0, 19) + "…" : s.name;
    const kindLabel = SYM_KIND_RU[s.kind] || s.kind;
    nodeHtml.push(
      '<g class="node node-symbol ' + cls + '" tabindex="0" role="button" aria-label="Символ ' + escHtml(s.name) + ' (' + escHtml(kindLabel) + ')" data-id="' + escHtml(s.id) + '" transform="translate(' + x + ',' + y + ')">' +
      '<rect width="' + nodeW + '" height="' + nodeH + '" rx="6"/>' +
      '<text class="nt" x="10" y="19">' + escHtml(label) + '</text>' +
      '<text class="nl" x="' + (nodeW - 10) + '" y="19" text-anchor="end">' + escHtml(kindLabel) + '</text>' +
      '</g>'
    );
  });
  nodeLayer.innerHTML = nodeHtml.join("\\n");
}

/* Render Per-File Local Graph View */
function renderFileLocalGraph(targetFile) {
  if (!targetFile || !DATA.files[targetFile]) return;
  currentTargetFile = targetFile;

  const f = DATA.files[targetFile];
  const imports = f.deps || [];
  const importedBy = USERS[targetFile] || [];
  const fileSymbols = SYMBOLS_BY_FILE.get(targetFile) || [];

  const symIds = new Set(fileSymbols.map((s) => s.id));
  const intraCalls = (DATA.calls || []).filter((c) => symIds.has(c.from) && symIds.has(c.to));

  const centerW = 240, centerH = 36;
  const sideW = 200, sideH = 28;
  const symW = 180, symH = 30;

  const leftCount = imports.length;
  const rightCount = importedBy.length;
  const ring1Rows = Math.max(1, Math.max(leftCount, rightCount));
  const topBlockHeight = 60 + ring1Rows * 42;

  const symCols = Math.min(3, Math.max(1, fileSymbols.length));
  const symRows = Math.ceil(fileSymbols.length / symCols) || 1;
  const bottomBlockHeight = symRows * 46 + 60;

  const totalWidth = 900;
  const totalHeight = topBlockHeight + bottomBlockHeight + 60;

  svg.setAttribute("viewBox", "0 0 " + totalWidth + " " + totalHeight);

  const centerX = (totalWidth - centerW) / 2;
  const centerY = 50 + (ring1Rows * 42) / 2 - centerH / 2;

  const leftX = 40;
  const rightX = totalWidth - 40 - sideW;

  const pos = new Map();
  pos.set(targetFile, { x: centerX, y: centerY, w: centerW, h: centerH, type: "center" });

  imports.forEach((dep, i) => {
    const y = 50 + i * 42;
    pos.set("dep:" + dep, { x: leftX, y, w: sideW, h: sideH, type: "dep", rawPath: dep });
  });

  importedBy.forEach((user, i) => {
    const y = 50 + i * 42;
    pos.set("user:" + user, { x: rightX, y, w: sideW, h: sideH, type: "user", rawPath: user });
  });

  // Position symbols below
  const symStartY = topBlockHeight + 30;
  const symStartX = (totalWidth - (symCols * 200 - 20)) / 2;

  fileSymbols.forEach((s, i) => {
    const c = i % symCols;
    const r = Math.floor(i / symCols);
    const x = symStartX + c * 200;
    const y = symStartY + r * 46;
    pos.set(s.id, { x, y, w: symW, h: symH, type: "symbol", symData: s });
  });

  // Edges:
  // center imports dep: center -> dep (arrow to left)
  // user imports center: user -> center (arrow to center)
  // intraCalls: symA -> symB
  const edgeHtml = [];

  imports.forEach((dep) => {
    const b = pos.get("dep:" + dep);
    if (!b) return;
    const x1 = centerX;
    const y1 = centerY + centerH / 2;
    const x2 = b.x + sideW;
    const y2 = b.y + sideH / 2;
    const mx = (x1 + x2) / 2;
    edgeHtml.push(
      '<path class="edge" data-from="' + escHtml(targetFile) + '" data-to="' + escHtml(dep) + '" d="M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2 + '" marker-end="url(#arrow)"/>'
    );
  });

  importedBy.forEach((user) => {
    const a = pos.get("user:" + user);
    if (!a) return;
    const x1 = a.x;
    const y1 = a.y + sideH / 2;
    const x2 = centerX + centerW;
    const y2 = centerY + centerH / 2;
    const mx = (x1 + x2) / 2;
    edgeHtml.push(
      '<path class="edge" data-from="' + escHtml(user) + '" data-to="' + escHtml(targetFile) + '" d="M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2 + '" marker-end="url(#arrow)"/>'
    );
  });

  intraCalls.forEach((c) => {
    const a = pos.get(c.from), b = pos.get(c.to);
    if (!a || !b) return;
    const x1 = a.x + symW, y1 = a.y + symH / 2;
    const x2 = b.x, y2 = b.y + symH / 2;
    const mx = (x1 + x2) / 2;
    edgeHtml.push(
      '<path class="edge" data-from="' + escHtml(c.from) + '" data-to="' + escHtml(c.to) + '" d="M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2 + '" marker-end="url(#arrow-active)"/>'
    );
  });
  edgeLayer.innerHTML = edgeHtml.join("\\n");

  // Nodes
  const nodeHtml = [];

  // Center node
  nodeHtml.push(
    '<g class="node node-file-center" tabindex="0" role="button" aria-label="Файл ' + escHtml(targetFile) + '" data-id="' + escHtml(targetFile) + '" data-path="' + escHtml(targetFile) + '" transform="translate(' + centerX + ',' + centerY + ')">' +
    '<rect width="' + centerW + '" height="' + centerH + '" rx="8"/>' +
    '<text class="nt" x="12" y="22" style="font-weight:700">📄 ' + escHtml(targetFile.length > 25 ? "…" + targetFile.slice(-24) : targetFile) + '</text>' +
    '<text class="nl" x="' + (centerW - 12) + '" y="22" text-anchor="end">' + f.loc + ' стр</text>' +
    '</g>'
  );

  // Section label for symbols
  if (fileSymbols.length) {
    nodeHtml.push(
      '<text x="' + (totalWidth / 2) + '" y="' + (topBlockHeight + 15) + '" text-anchor="middle" fill="#94a3b8" font-size="12" font-family="sans-serif">Символы и внутренние вызовы файла (' + fileSymbols.length + ')</text>'
    );
  }

  // Left imports nodes
  imports.forEach((dep) => {
    const pInfo = pos.get("dep:" + dep);
    if (!pInfo) return;
    const dLoc = (DATA.files[dep] && DATA.files[dep].loc) || 0;
    const lbl = dep.length > 22 ? "…" + dep.slice(-21) : dep;
    nodeHtml.push(
      '<g class="node node-dep" tabindex="0" role="button" aria-label="Импортирует ' + escHtml(dep) + '" data-id="' + escHtml(dep) + '" data-path="' + escHtml(dep) + '" transform="translate(' + pInfo.x + ',' + pInfo.y + ')">' +
      '<rect width="' + sideW + '" height="' + sideH + '" rx="6"/>' +
      '<text class="nt" x="8" y="18">' + escHtml(lbl) + '</text>' +
      '<text class="nl" x="' + (sideW - 8) + '" y="18" text-anchor="end">' + dLoc + ' стр</text>' +
      '</g>'
    );
  });

  // Right users nodes
  importedBy.forEach((user) => {
    const pInfo = pos.get("user:" + user);
    if (!pInfo) return;
    const uLoc = (DATA.files[user] && DATA.files[user].loc) || 0;
    const lbl = user.length > 22 ? "…" + user.slice(-21) : user;
    nodeHtml.push(
      '<g class="node node-user" tabindex="0" role="button" aria-label="Импортируется файлом ' + escHtml(user) + '" data-id="' + escHtml(user) + '" data-path="' + escHtml(user) + '" transform="translate(' + pInfo.x + ',' + pInfo.y + ')">' +
      '<rect width="' + sideW + '" height="' + sideH + '" rx="6"/>' +
      '<text class="nt" x="8" y="18">' + escHtml(lbl) + '</text>' +
      '<text class="nl" x="' + (sideW - 8) + '" y="18" text-anchor="end">' + uLoc + ' стр</text>' +
      '</g>'
    );
  });

  // Symbols below
  fileSymbols.forEach((s) => {
    const pInfo = pos.get(s.id);
    if (!pInfo) return;
    const lbl = s.name.length > 18 ? s.name.slice(0, 17) + "…" : s.name;
    const kLabel = SYM_KIND_RU[s.kind] || s.kind;
    nodeHtml.push(
      '<g class="node node-symbol-local" tabindex="0" role="button" aria-label="Символ ' + escHtml(s.name) + '" data-id="' + escHtml(s.id) + '" transform="translate(' + pInfo.x + ',' + pInfo.y + ')">' +
      '<rect width="' + symW + '" height="' + symH + '" rx="6"/>' +
      '<text class="nt" x="8" y="19">' + escHtml(lbl) + '</text>' +
      '<text class="nl" x="' + (symW - 8) + '" y="19" text-anchor="end">' + escHtml(kLabel) + '</text>' +
      '</g>'
    );
  });

  nodeLayer.innerHTML = nodeHtml.join("\\n");
}

/* Open per-file view with history state preservation */
function openFileLocalGraph(path) {
  if (!DATA.files[path]) return;
  if (currentMode !== "file") {
    savedViewState = {
      mode: currentMode,
      tx, ty, k,
      selectedId,
      selectedType,
    };
  }
  currentTargetFile = path;
  setMode("file");
  selectModule(path);
}

/* Render Problems Mode */
function renderProblemsMode() {
  const problems = Array.isArray(DATA.problems) ? DATA.problems : [];

  if (!problems.length) {
    // Legacy fallback: show findings
    const shown = (DATA.findings && DATA.findings.shown) || [];
    if (!shown.length) {
      problemsView.innerHTML = '<div class="card"><p class="muted">Замечаний и проблем в архитектуре не обнаружено.</p></div>';
      return;
    }
    const cards = shown.map((f) => {
      const sevLabel = SEV_RU[f.severity] || f.severity || "инфо";
      const kindLabel = KIND_RU[f.kind] || f.kind || "замечание";
      return (
        '<div class="prob-card ' + escHtml(f.severity || "low") + '">' +
          '<div class="prob-header">' +
            '<div class="prob-badges">' +
              '<span class="badge-sev ' + escHtml(f.severity || "low") + '">' + escHtml(sevLabel) + '</span>' +
              '<span class="badge-cat">' + escHtml(kindLabel) + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="prob-title">' + escHtml(f.what || f.title || "") + '</div>' +
          '<div class="prob-why">' + escHtml(f.why || "") + '</div>' +
          (f.fix ? '<div class="prob-fix"><b>Рекомендация:</b> ' + escHtml(f.fix) + '</div>' : '') +
          '<div class="prob-locations">' +
            (f.where || []).map((w) => '<span class="loc-chip" role="button" tabindex="0" data-path="' + escHtml(w) + '">' + escHtml(w) + '</span>').join("") +
          '</div>' +
        '</div>'
      );
    }).join("");
    problemsView.innerHTML = cards;
    bindProblemInteractions();
    return;
  }

  // Count by category
  const counts = { all: problems.length, structure: 0, optimization: 0, security: 0, reliability: 0, maintainability: 0 };
  problems.forEach((p) => {
    if (counts[p.category] !== undefined) counts[p.category]++;
  });

  // Filter chips
  const categories = [
    { id: "all", label: "Все" },
    { id: "structure", label: "Структура" },
    { id: "optimization", label: "Оптимизация" },
    { id: "security", label: "Безопасность" },
    { id: "reliability", label: "Надёжность" },
    { id: "maintainability", label: "Сопровождаемость" },
  ];

  const filterHtml = (
    '<div class="prob-filters">' +
      categories.map((c) =>
        '<span class="prob-chip ' + (activeProblemCategory === c.id ? "active" : "") + '" role="button" tabindex="0" data-category="' + c.id + '">' +
          c.label + ' (' + (counts[c.id] || 0) + ')' +
        '</span>'
      ).join("") +
    '</div>'
  );

  const filtered = activeProblemCategory === "all"
    ? problems
    : problems.filter((p) => p.category === activeProblemCategory);

  // Group by severity: critical -> high -> medium -> low
  const groups = [
    { id: "critical", label: "Критические проблемы" },
    { id: "high", label: "Высокий приоритет" },
    { id: "medium", label: "Средний приоритет" },
    { id: "low", label: "Низкий приоритет" },
  ];

  const groupsHtml = groups.map((g) => {
    const list = filtered.filter((p) => p.severity === g.id);
    if (!list.length) return "";
    const items = list.map((p) => {
      const sevLabel = PROBLEM_SEVERITY_RU[p.severity] || p.severity;
      const catLabel = PROBLEM_CATEGORY_RU[p.category] || p.category;
      const locChips = (p.where || []).map((w) => {
        const file = typeof w === "string" ? w : w.file;
        const line = typeof w === "object" && w.line ? ":" + w.line : "";
        return '<span class="loc-chip" role="button" tabindex="0" data-path="' + escHtml(file) + '" title="Открыть локальный граф файла">' + escHtml(file + line) + '</span>';
      }).join("");

      return (
        '<div class="prob-card ' + escHtml(p.severity) + '">' +
          '<div class="prob-header">' +
            '<div class="prob-badges">' +
              '<span class="badge-sev ' + escHtml(p.severity) + '">' + escHtml(sevLabel) + '</span>' +
              '<span class="badge-cat">' + escHtml(catLabel) + '</span>' +
            '</div>' +
            (p.prompt ? '<button class="btn-copy-prompt" data-prompt="' + escHtml(p.prompt) + '">Копировать промпт для ИИ</button>' : '') +
          '</div>' +
          '<div class="prob-title">' + escHtml(p.title) + '</div>' +
          '<div class="prob-why">' + escHtml(p.why) + '</div>' +
          (p.fix ? '<div class="prob-fix"><b>Решение:</b> ' + escHtml(p.fix) + '</div>' : '') +
          (locChips ? '<div class="prob-locations">' + locChips + '</div>' : '') +
        '</div>'
      );
    }).join("");

    return (
      '<div class="prob-group">' +
        '<div class="prob-group-title ' + g.id + '">' + g.label + ' (' + list.length + ')</div>' +
        items +
      '</div>'
    );
  }).join("");

  problemsView.innerHTML = filterHtml + (groupsHtml || '<p class="muted">В выбранной категории проблем не обнаружено.</p>');
  bindProblemInteractions();
}

function bindProblemInteractions() {
  // Category chips
  problemsView.querySelectorAll(".prob-filters .prob-chip").forEach((chip) => {
    const switchCat = () => {
      activeProblemCategory = chip.getAttribute("data-category");
      renderProblemsMode();
    };
    chip.addEventListener("click", switchCat);
    chip.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        switchCat();
      }
    });
  });

  // Copy prompt buttons
  problemsView.querySelectorAll(".btn-copy-prompt").forEach((btn) => {
    const doCopy = (e) => {
      e.stopPropagation();
      const prompt = btn.getAttribute("data-prompt");
      if (prompt) copyPromptToClipboard(prompt, btn);
    };
    btn.addEventListener("click", doCopy);
    btn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        doCopy(e);
      }
    });
  });

  // Location chips jump to file local graph
  problemsView.querySelectorAll(".loc-chip").forEach((chip) => {
    const jump = () => {
      const path = chip.getAttribute("data-path");
      if (path && DATA.files[path]) {
        openFileLocalGraph(path);
      }
    };
    chip.addEventListener("click", jump);
    chip.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        jump();
      }
    });
  });
}

/* Close side panel */
function closePanel() {
  panel.classList.remove("open");
  selectedId = null;
  selectedType = null;
  highlightNeighbors(null);
}
panelClose.addEventListener("click", closePanel);

/* Highlight incoming/outgoing neighbors */
function highlightNeighbors(id) {
  const nodes = nodeLayer.querySelectorAll(".node");
  const edges = edgeLayer.querySelectorAll(".edge");

  if (!id) {
    nodes.forEach((n) => {
      n.classList.remove("dimmed", "selected");
    });
    edges.forEach((e) => {
      e.classList.remove("active");
    });
    return;
  }

  const activeNodes = new Set([id]);

  if (currentMode === "calls") {
    const callers = CALLERS_BY_SYM.get(id) || [];
    const callees = CALLEES_BY_SYM.get(id) || [];
    callers.forEach((c) => activeNodes.add(c.from));
    callees.forEach((c) => activeNodes.add(c.to));
  } else {
    const f = DATA.files[id];
    if (f) {
      (f.deps || []).forEach((d) => activeNodes.add(d));
      (USERS[id] || []).forEach((u) => activeNodes.add(u));
    }
  }

  nodes.forEach((n) => {
    const nId = n.getAttribute("data-id");
    if (activeNodes.has(nId)) {
      n.classList.remove("dimmed");
      n.classList.toggle("selected", nId === id);
    } else {
      n.classList.add("dimmed");
      n.classList.remove("selected");
    }
  });

  edges.forEach((e) => {
    const from = e.getAttribute("data-from");
    const to = e.getAttribute("data-to");
    const isActive = from === id || to === id;
    e.classList.toggle("active", isActive);
  });
}

/* Focus and center a node */
function focusNode(id) {
  const g = nodeLayer.querySelector('[data-id="' + CSS.escape(id) + '"]');
  if (!g) return;
  const tf = g.getAttribute("transform");
  const m = tf ? tf.match(/translate\(([^,]+),([^)]+)\)/) : null;
  if (!m) return;
  const nx = parseFloat(m[1]), ny = parseFloat(m[2]);
  const rect = gw.getBoundingClientRect();
  tx = rect.width / 2 - (nx + 100) * k;
  ty = rect.height / 2 - (ny + 15) * k;
  applyTransform();
}

/* Inspect module */
function selectModule(path) {
  const f = DATA.files[path];
  if (!f) return;
  selectedId = path;
  selectedType = "module";
  highlightNeighbors(path);
  focusNode(path);

  const syms = SYMBOLS_BY_FILE.get(path) || [];
  const deps = (f.deps || []).length
    ? f.deps.map((d) => '<li><code class="jump" tabindex="0" role="button" aria-label="Открыть модуль ' + escHtml(d) + '" data-target="' + escHtml(d) + '" data-type="module">' + escHtml(d) + '</code></li>').join("")
    : '<li class="muted">Нет зависимостей</li>';

  const users = (USERS[path] || []).length
    ? USERS[path].map((u) => '<li><code class="jump" tabindex="0" role="button" aria-label="Открыть модуль ' + escHtml(u) + '" data-target="' + escHtml(u) + '" data-type="module">' + escHtml(u) + '</code></li>').join("")
    : '<li class="muted">Никем не импортируется</li>';

  const symHtml = syms.length
    ? '<ul class="plist">' +
        syms.map((s) => '<li><code class="jump" tabindex="0" role="button" aria-label="Выбрать функцию ' + escHtml(s.name) + '" data-target="' + escHtml(s.id) + '" data-type="symbol">' + escHtml(s.name) + '</code> <span class="muted">(' + escHtml(SYM_KIND_RU[s.kind] || s.kind) + ', стр. ' + s.line + ')</span></li>').join("") +
      '</ul>'
    : f.members && f.members.length
    ? '<ul class="plist">' +
        f.members.map((m) => '<li><code>' + escHtml(m.name) + '</code> <span class="muted">(' + escHtml(SYM_KIND_RU[m.kind] || m.kind) + ', стр. ' + m.line + ')</span></li>').join("") +
      '</ul>'
    : '<p class="muted">Деклараций не обнаружено</p>';

  const unres = (DATA.unresolvedCalls || []).filter((u) => u.file === path);
  const unresHtml = unres.length
    ? unres.map((u) =>
        '<div class="call-item">' +
          '<div class="call-expr">' + escHtml(u.expression) + ' (стр. ' + u.line + ')</div>' +
          '<div class="call-reason">' + escHtml(REASON_RU[u.reason] || u.reason) + '</div>' +
        '</div>'
      ).join("")
    : '<p class="muted">Неразрешённых вызовов нет</p>';

  panelContent.innerHTML =
    '<h3>Модуль</h3>' +
    '<p><code>' + escHtml(path) + '</code></p>' +
    '<button class="btn-action btn-open-file" id="btn-open-file-graph" data-path="' + escHtml(path) + '" style="margin: 10px 0; width: 100%; font-weight: 600;">Открыть локальный граф файла</button>' +
    '<div class="kv">' +
      '<span class="k">Строк кода</span><span class="v">' + f.loc + '</span>' +
      '<span class="k">Сложность (ветвления)</span><span class="v">' + f.complexity + '</span>' +
      '<span class="k">Индекс MI</span><span class="v">' + f.mi + ' / 100</span>' +
      '<span class="k">Входящие зависимости</span><span class="v">' + f.fanIn + '</span>' +
      '<span class="k">Исходящие зависимости</span><span class="v">' + f.fanOut + '</span>' +
    '</div>' +
    '<h3>Объявления и функции (' + (syms.length || f.members.length) + ')</h3>' +
    symHtml +
    '<h3>Импортирует модули (' + (f.deps || []).length + ')</h3>' +
    '<ul class="plist">' + deps + '</ul>' +
    '<h3>Импортируется модулями (' + (USERS[path] || []).length + ')</h3>' +
    '<ul class="plist">' + users + '</ul>' +
    '<h3>Неразрешённые вызовы (' + unres.length + ')</h3>' +
    unresHtml;

  const btnOpen = panelContent.querySelector("#btn-open-file-graph");
  if (btnOpen) {
    btnOpen.addEventListener("click", () => openFileLocalGraph(path));
  }

  bindJumps();
  panel.classList.add("open");
}

/* Inspect symbol */
function selectSymbol(id) {
  const s = SYMBOLS_BY_ID.get(id);
  if (!s) return;
  if (currentMode !== "calls") {
    setMode("calls");
  }
  if (!nodeLayer.querySelector('[data-id="' + CSS.escape(id) + '"]')) {
    if (callsFilterConnectedOnly) {
      callsFilterConnectedOnly = false;
      if (btnConnectedFilter) btnConnectedFilter.textContent = "Только связанные";
      renderCallsMode();
    }
  }
  selectedId = id;
  selectedType = "symbol";
  highlightNeighbors(id);
  focusNode(id);

  const callers = CALLERS_BY_SYM.get(id) || [];
  const callees = CALLEES_BY_SYM.get(id) || [];
  const unres = UNRESOLVED_BY_SYM.get(id) || [];

  const callersHtml = callers.length
    ? callers.map((c) => {
        const callerSym = SYMBOLS_BY_ID.get(c.from);
        const name = callerSym ? callerSym.name : c.from;
        return '<li><code class="jump" tabindex="0" role="button" aria-label="Выбрать символ ' + escHtml(name) + '" data-target="' + escHtml(c.from) + '" data-type="symbol">' + escHtml(name) + '</code> <span class="muted">(стр. ' + c.line + ')</span></li>';
      }).join("")
    : '<li class="muted">Прямых вызовов не обнаружено</li>';

  const calleesHtml = callees.length
    ? callees.map((c) => {
        const calleeSym = SYMBOLS_BY_ID.get(c.to);
        const name = calleeSym ? calleeSym.name : c.to;
        return '<li><code class="jump" tabindex="0" role="button" aria-label="Выбрать символ ' + escHtml(name) + '" data-target="' + escHtml(c.to) + '" data-type="symbol">' + escHtml(name) + '</code> <span class="muted">(стр. ' + c.line + ')</span></li>';
      }).join("")
    : '<li class="muted">Не вызывает другие известные символы</li>';

  const unresHtml = unres.length
    ? unres.map((u) =>
        '<div class="call-item">' +
          '<div class="call-expr">' + escHtml(u.expression) + ' (стр. ' + u.line + ')</div>' +
          '<div class="call-reason">' + escHtml(REASON_RU[u.reason] || u.reason) + '</div>' +
        '</div>'
      ).join("")
    : '<p class="muted">Все вызовы внутри функции разрешены</p>';

  panelContent.innerHTML =
    '<h3>Символ (функция / метод)</h3>' +
    '<p><strong style="font-size:16px;color:#f8fafc">' + escHtml(s.name) + '</strong> <span class="muted">(' + escHtml(SYM_KIND_RU[s.kind] || s.kind) + ')</span></p>' +
    '<p style="margin-top:4px"><code class="jump" tabindex="0" role="button" aria-label="Открыть модуль ' + escHtml(s.file) + '" data-target="' + escHtml(s.file) + '" data-type="module">' + escHtml(s.file) + ':' + s.line + '-' + s.endLine + '</code></p>' +
    '<div class="kv">' +
      '<span class="k">Строки в файле</span><span class="v">' + s.line + '–' + s.endLine + ' (' + (s.endLine - s.line + 1) + ' стр)</span>' +
      '<span class="k">Входящих вызовов</span><span class="v">' + callers.length + '</span>' +
      '<span class="k">Исходящих вызовов</span><span class="v">' + callees.length + '</span>' +
    '</div>' +
    '<h3>Кто вызывает (' + callers.length + ')</h3>' +
    '<ul class="plist">' + callersHtml + '</ul>' +
    '<h3>Кого вызывает (' + callees.length + ')</h3>' +
    '<ul class="plist">' + calleesHtml + '</ul>' +
    '<h3>Неразрешённые вызовы (' + unres.length + ')</h3>' +
    unresHtml;

  bindJumps();
  panel.classList.add("open");
}

function bindJumps() {
  panelContent.querySelectorAll(".jump").forEach((el) => {
    const target = el.getAttribute("data-target");
    const type = el.getAttribute("data-type");
    const jump = () => {
      if (type === "module") selectModule(target);
      else if (type === "symbol") selectSymbol(target);
    };
    el.addEventListener("click", jump);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        jump();
      }
    });
  });
}

/* Handle node click & keyboard action */
function handleNodeAction(g) {
  if (g.classList.contains("node-cluster")) {
    const fld = g.getAttribute("data-folder");
    if (fld) {
      if (expandedClusters.has(fld)) {
        expandedClusters.delete(fld);
      } else {
        expandedClusters.add(fld);
      }
      renderModulesMode();
      fitGraph();
    }
    return;
  }
  const id = g.getAttribute("data-id");
  if (!id) return;
  if (g.classList.contains("node-module") || g.classList.contains("node-file-center") || g.classList.contains("node-dep") || g.classList.contains("node-user")) {
    selectModule(id);
  } else if (g.classList.contains("node-symbol") || g.classList.contains("node-symbol-local")) {
    selectSymbol(id);
  }
}

nodeLayer.addEventListener("click", (e) => {
  const g = e.target.closest(".node");
  if (g) handleNodeAction(g);
});

nodeLayer.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    const g = e.target.closest(".node");
    if (g) {
      e.preventDefault();
      handleNodeAction(g);
    }
  }
});

/* Keyboard shortcuts */
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (gw.classList.contains("fullscreen")) {
      toggleFullscreen(false);
    } else if (panel.classList.contains("open")) {
      closePanel();
    } else {
      searchResults.classList.remove("open");
      highlightNeighbors(null);
    }
  }
});

/* Search interaction: search modules, symbols and problems */
searchInput.addEventListener("input", (e) => {
  const query = e.target.value.trim().toLowerCase();
  if (!query) {
    searchResults.classList.remove("open");
    searchResults.innerHTML = "";
    return;
  }

  const matched = [];

  // Search modules
  for (const p of FILE_KEYS) {
    if (p.toLowerCase().includes(query)) {
      matched.push({ id: p, name: p, type: "module", tag: "модуль" });
    }
  }

  // Search symbols
  for (const s of (DATA.symbols || [])) {
    if (s.name.toLowerCase().includes(query) || s.file.toLowerCase().includes(query)) {
      matched.push({ id: s.id, name: s.name + " (" + s.file + ":" + s.line + ")", type: "symbol", tag: SYM_KIND_RU[s.kind] || s.kind });
    }
  }

  // Search problems
  for (const prob of (DATA.problems || [])) {
    if ((prob.title && prob.title.toLowerCase().includes(query)) ||
        (prob.why && prob.why.toLowerCase().includes(query)) ||
        (prob.category && prob.category.toLowerCase().includes(query))) {
      const fileWhere = (prob.where && prob.where[0] && prob.where[0].file) ? prob.where[0].file : "";
      matched.push({ id: fileWhere || prob.id, name: prob.title, type: fileWhere ? "problem" : "module", tag: "проблема" });
    }
  }

  if (!matched.length) {
    searchResults.innerHTML = '<div class="search-item muted">Ничего не найдено</div>';
    searchResults.classList.add("open");
    return;
  }

  searchResults.innerHTML = matched.slice(0, 30).map((m) =>
    '<div class="search-item" tabindex="0" role="button" aria-label="' + escHtml(m.tag) + ' ' + escHtml(m.name) + '" data-id="' + escHtml(m.id) + '" data-type="' + escHtml(m.type) + '">' +
      '<span>' + escHtml(m.name) + '</span>' +
      '<span class="tag">' + escHtml(m.tag) + '</span>' +
    '</div>'
  ).join("");
  searchResults.classList.add("open");

  searchResults.querySelectorAll(".search-item").forEach((item) => {
    const selectItem = () => {
      const id = item.getAttribute("data-id");
      const type = item.getAttribute("data-type");
      searchResults.classList.remove("open");
      if (type === "module") selectModule(id);
      else if (type === "symbol") selectSymbol(id);
      else if (type === "problem") {
        if (DATA.files[id]) openFileLocalGraph(id);
        else setMode("problems");
      }
    };
    item.addEventListener("click", selectItem);
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectItem();
      }
    });
  });
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-box")) {
    searchResults.classList.remove("open");
  }
});

/* Bind external file links */
document.querySelectorAll(".flink").forEach((el) => {
  const openLink = () => {
    const path = el.getAttribute("data-path");
    if (path) {
      if (currentMode === "problems") setMode("modules");
      selectModule(path);
    }
  };
  el.addEventListener("click", openLink);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openLink();
    }
  });
});

/* Initial center */
fitGraph();
</script>
</body>
</html>`;
}
