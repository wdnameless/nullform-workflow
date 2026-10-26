#!/usr/bin/env node
/**
 * tools/dashboard-sketch.mjs — hand-drawn (Excalidraw-style) geometry for the
 * architecture map, plus a .excalidraw exporter. No dependencies, no DOM.
 *
 * Why a separate module: the layout is a pure function from nodes+edges to paths, and
 * that purity is the contract — the dashboard re-renders every 2 s, so any use of
 * Math.random() would make the diagram twitch on every poll. Determinism here is
 * per-node: the seed is hashed from the node id, so adding a node never reshuffles
 * the ones already on screen.
 *
 * The drawing is deliberately "rough": each edge is drawn twice with a small offset,
 * each box is a closed path with jittered corners and a slight over/undershoot at the
 * seam. That is the Excalidraw look without the library.
 */

/** FNV-1a over the string — stable across processes and platforms. */
export function seedOf(text) {
  let h = 0x811c9dc5;
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Mulberry32: tiny, fast, deterministic. Returns floats in [0,1). */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Rounded rectangle as one closed path, corners jittered by ±j. */
export function sketchBoxPath(x, y, w, h, seed, { r = 10, j = 1.1 } = {}) {
  const rnd = seededRandom(seed);
  const noise = () => (rnd() - 0.5) * 2 * j;
  const rr = Math.min(r, w / 2, h / 2);
  const p = (px, py) => `${(px + noise()).toFixed(2)} ${(py + noise()).toFixed(2)}`;
  return [
    `M ${p(x + rr, y)}`,
    `L ${p(x + w - rr, y)}`,
    `Q ${p(x + w, y)} ${p(x + w, y + rr)}`,
    `L ${p(x + w, y + h - rr)}`,
    `Q ${p(x + w, y + h)} ${p(x + w - rr, y + h)}`,
    `L ${p(x + rr, y + h)}`,
    `Q ${p(x, y + h)} ${p(x, y + h - rr)}`,
    `L ${p(x, y + rr)}`,
    `Q ${p(x, y)} ${p(x + rr, y)}`,
    "Z",
  ].join(" ");
}

/** Cubic edge from a's right-middle to b's left-middle, bowed by `curve`. */
export function sketchEdgePath(a, b, seed, curve = 0.35) {
  const rnd = seededRandom(seed);
  const wobble = (rnd() - 0.5) * 10;
  const x1 = a.x + a.w;
  const y1 = a.y + a.h / 2;
  const x2 = b.x;
  const y2 = b.y + b.h / 2;
  const dx = Math.max(40, Math.abs(x2 - x1) * curve);
  const c1x = x1 + dx;
  const c1y = y1 + wobble;
  const c2x = x2 - dx;
  const c2y = y2 - wobble;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

/** Уровень = кратчайший путь от корня: 0 у проекта, дальше по рёбрам. */
function assignLevels(nodes, incoming, outgoing) {
  const level = new Map();
  const roots = nodes.filter((n) => !(incoming.get(n.id) || []).length);
  const queue = [];
  for (const r of roots.length ? roots : [nodes[0]]) {
    level.set(r.id, 0);
    queue.push(r.id);
  }
  while (queue.length) {
    const cur = queue.shift();
    const next = level.get(cur) + 1;
    for (const to of outgoing.get(cur) || []) {
      if (!level.has(to)) {
        level.set(to, next);
        queue.push(to);
      }
    }
  }
  for (const n of nodes) if (!level.has(n.id)) level.set(n.id, 0);
  return level;
}

/**
 * Каждый уровень режется на физические колонки по `perColumn`.
 * Без нарезки звезда «файл → 40 символов» вытягивалась в полосу высотой 2.6k пикселей.
 */
function packBands(nodes, level, perColumn) {
  const columns = new Map();
  for (const n of nodes) {
    const lv = level.get(n.id);
    if (!columns.has(lv)) columns.set(lv, []);
    columns.get(lv).push(n);
  }
  const bands = [];
  let maxRows = 1;
  for (const lv of [...columns.keys()].sort((a, b) => a - b)) {
    const col = columns.get(lv);
    const groups = [];
    for (let i = 0; i < col.length; i += perColumn) groups.push(col.slice(i, i + perColumn));
    if (!groups.length) groups.push([]);
    bands.push({ lv, cols: groups });
    maxRows = Math.max(maxRows, ...groups.map((g) => g.length));
  }
  return { bands, maxRows };
}

/**
 * Layered left-to-right layout.
 *
 * Level 0 = the node with no parents (the project), each following level is one hop
 * from the previous. Nodes that no edge reaches are placed on level 0, so a filter
 * that hides every edge still draws something.
 */
export function layoutSketch({ nodes = [], edges = [] } = {}, { width = 900, boxW = 210, boxH = 52, gapX = 70, gapY = 14, pad = 24, perColumn = 12 } = {}) {
  if (!nodes.length) return { nodes: [], edges: [], w: width, h: 120 };

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outgoing = new Map();
  const incoming = new Map();
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    if (!outgoing.has(e.from)) outgoing.set(e.from, []);
    outgoing.get(e.from).push(e.to);
    if (!incoming.has(e.to)) incoming.set(e.to, []);
    incoming.get(e.to).push(e.from);
  }

  const level = assignLevels(nodes, incoming, outgoing);
  const { bands, maxRows } = packBands(nodes, level, perColumn);
  const totalH = Math.max(boxH + pad * 2, maxRows * (boxH + gapY) - gapY + pad * 2);

  const placed = new Map();
  let colIndex = 0;
  for (const band of bands) {
    for (const group of band.cols) {
      const x = pad + colIndex * (boxW + gapX);
      const columnHeight = group.length * (boxH + gapY) - gapY;
      const y0 = pad + Math.max(0, (totalH - pad * 2 - columnHeight) / 2);
      group.forEach((n, i) => {
        placed.set(n.id, {
          id: n.id,
          label: String(n.label ?? n.id),
          sub: String(n.sub ?? ""),
          kind: String(n.kind || "other"),
          href: n.href ?? null,
          level: band.lv,
          parents: incoming.get(n.id) || [],
          x,
          y: y0 + i * (boxH + gapY),
          w: boxW,
          h: boxH,
        });
      });
      colIndex += 1;
    }
  }

  const placedNodes = nodes.map((n) => placed.get(n.id)).filter(Boolean);
  return {
    nodes: placedNodes,
    edges: edges.filter((e) => placed.has(e.from) && placed.has(e.to)).map((e) => ({ from: e.from, to: e.to, weight: Number(e.weight) || 1 })),
    w: clamp(pad * 2 + colIndex * boxW + Math.max(0, colIndex - 1) * gapX, 320, width * 4),
    h: totalH,
  };
}

const PALETTE = {
  root: "#a5d8ff",
  code: "#b2f2bb",
  law: "#fff3bf",
  skills: "#d0bfff",
  spec: "#c3fae8",
  tests: "#ffd8a8",
  file: "#e9ecef",
  symbol: "#f1f3f5",
  other: "#e9ecef",
};

export function fillFor(kind) {
  return PALETTE[kind] || PALETTE.other;
}

/**
 * `.excalidraw` envelope for the current sketch.
 *
 * Container-bound text, documented element types only: the skill explicitly warns that
 * `label: {...}` on a shape is silently ignored and yields blank boxes.
 */
export function toExcalidraw(sketch, title = "architecture") {
  const elements = [];
  const stroke = "#1e1e1e";
  for (const n of sketch.nodes || []) {
    const rectId = `n-${n.id}`;
    const textId = `t-${n.id}`;
    const label = n.sub ? `${n.label}\n${n.sub}` : n.label;
    elements.push({
      type: "rectangle",
      id: rectId,
      x: Math.round(n.x),
      y: Math.round(n.y),
      width: Math.round(n.w),
      height: Math.round(n.h),
      roundness: { type: 3 },
      backgroundColor: fillFor(n.kind),
      fillStyle: "solid",
      strokeColor: stroke,
      strokeWidth: 2,
      roughness: 1,
      boundElements: [{ id: textId, type: "text" }],
    });
    elements.push({
      type: "text",
      id: textId,
      x: Math.round(n.x + 6),
      y: Math.round(n.y + 8),
      width: Math.round(n.w - 12),
      height: Math.round(n.h - 12),
      text: label,
      originalText: label,
      fontSize: n.kind === "root" ? 18 : 15,
      fontFamily: 1,
      strokeColor: stroke,
      textAlign: "center",
      verticalAlign: "middle",
      containerId: rectId,
      autoResize: true,
    });
  }
  for (const e of sketch.edges || []) {
    const a = (sketch.nodes || []).find((n) => n.id === e.from);
    const b = (sketch.nodes || []).find((n) => n.id === e.to);
    if (!a || !b) continue;
    const x1 = Math.round(a.x + a.w);
    const y1 = Math.round(a.y + a.h / 2);
    const x2 = Math.round(b.x);
    const y2 = Math.round(b.y + b.h / 2);
    elements.push({
      type: "arrow",
      id: `e-${e.from}-${e.to}`,
      x: x1,
      y: y1,
      width: x2 - x1,
      height: y2 - y1,
      points: [[0, 0], [x2 - x1, y2 - y1]],
      endArrowhead: "arrow",
      strokeColor: stroke,
      strokeWidth: e.weight > 1 ? 2 : 1,
      roughness: 1,
      startBinding: { elementId: `n-${e.from}`, fixedPoint: [1, 0.5] },
      endBinding: { elementId: `n-${e.to}`, fixedPoint: [0, 0.5] },
    });
  }
  return {
    type: "excalidraw",
    version: 2,
    source: "nullform-dashboard",
    elements,
    appState: { viewBackgroundColor: "#ffffff", gridSize: null },
    files: {},
    title: String(title || "architecture"),
  };
}

/**
 * Один уровень погружения: проект → модули, модуль → файлы, файл → символы.
 *
 * Раскладка живёт на сервере, а не в браузере, по одной причине: экспорт
 * `.excalidraw` обязан совпадать с тем, что видно на экране. Две реализации одной
 * геометрии разошлись бы на первой правке.
 */
export function buildSketch(drill, graph = null, { module: moduleName = null, file = null } = {}) {
  const mods = Array.isArray(drill?.modules) ? drill.modules : [];
  const mod = moduleName ? mods.find((m) => m.name === moduleName) || null : null;
  const fileNode = mod && file ? (mod.children || []).find((f) => f.path === file) || null : null;
  if (fileNode) return finish(symbolLevel(drill, mod, fileNode), { crumbs: crumbsFor(drill, mod, fileNode) });
  if (mod) return finish(fileLevel(drill, mod), { crumbs: crumbsFor(drill, mod, null), truncated: Boolean(mod.truncated) });
  return finish(projectLevel(drill, graph), { crumbs: crumbsFor(drill, null, null) });
}

const shortNum = (n) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));

/** Хлебные крошки: проект → модуль → файл. */
function crumbsFor(drill, mod, fileNode) {
  const out = [{ label: drill?.name || "project" }];
  if (mod) out.push({ label: mod.name, module: mod.name });
  if (fileNode) out.push({ label: fileNode.path.split("/").pop(), module: mod.name, file: fileNode.path });
  return out;
}

/** Уровень «символы файла»: файл в центре, каждый символ — ребёнок. */
function symbolLevel(drill, mod, fileNode) {
  const nodes = [{ id: "self", label: fileNode.path.split("/").pop(), sub: `${shortNum(fileNode.lines)} строк`, kind: "file" }];
  const edges = [];
  for (const s of fileNode.symbols || []) {
    const id = `s:${s.name}:${s.startLine}`;
    nodes.push({
      id,
      label: s.name,
      sub: `${s.startLine}\u2013${s.endLine}${s.internalCalls ? ` \u00b7 ${s.internalCalls}\u21bb` : ""}`,
      kind: "symbol",
    });
    edges.push({ from: "self", to: id, weight: 1 + Math.min(3, s.internalCalls || 0) });
  }
  return { level: "file", nodes, edges };
}

/** Уровень «файлы модуля». */
function fileLevel(drill, mod) {
  const nodes = [{ id: "self", label: mod.name, sub: `${shortNum(mod.files)} файлов \u00b7 ${shortNum(mod.lines)} строк`, kind: "code" }];
  const edges = [];
  for (const f of mod.children || []) {
    const id = `f:${f.path}`;
    nodes.push({
      id,
      label: f.path.split("/").pop(),
      sub: `${f.lines} строк \u00b7 ${(f.symbols || []).length} симв.`,
      kind: "file",
    });
    edges.push({ from: "self", to: id, weight: 1 });
  }
  return { level: "module", nodes, edges };
}

/** Верхний уровень: проект и модули, плюс реальные связи модуль → модуль. */
function projectLevel(drill, graph) {
  const nodes = [{ id: "project", label: drill?.name || "project", sub: `${shortNum(drill?.files || 0)} файлов \u00b7 ${shortNum(drill?.lines || 0)} строк`, kind: "root" }];
  const edges = [];
  const mods = Array.isArray(drill?.modules) ? drill.modules : [];
  for (const m of mods) {
    const id = `m:${m.name}`;
    nodes.push({ id, label: m.name, sub: `${shortNum(m.files)} файлов`, kind: kindOfModule(m.name) });
    edges.push({ from: "project", to: id, weight: 1 });
  }
  const known = new Set(nodes.map((n) => n.id));
  for (const e of graph?.edges || []) {
    if (e.from === e.to) continue;
    const from = `m:${e.from}`;
    const to = `m:${e.to}`;
    if (!known.has(from) || !known.has(to)) continue;
    edges.push({ from, to, weight: Number(e.weight) || 1, relation: true });
  }
  return { level: "project", nodes, edges };
}

function kindOfModule(name) {
  if (name === "agent" || name === "rules") return "law";
  if (name === "skills") return "skills";
  if (name === "tests") return "tests";
  if (name === "openspec") return "spec";
  return "code";
}

/** Раскладка + подписи путей: клиенту остаётся только вставить `d` в SVG. */
function finish({ level, nodes, edges }, extra = {}) {
  const spec = layoutSketch({ nodes, edges }, { width: 1180 });
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  return {
    level,
    w: Math.round(spec.w),
    h: Math.round(spec.h),
    ...extra,
    nodes: spec.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      sub: n.sub,
      kind: n.kind,
      x: Math.round(n.x),
      y: Math.round(n.y),
      w: n.w,
      h: n.h,
      fill: fillFor(n.kind),
      box: sketchBoxPath(n.x, n.y, n.w, n.h, seedOf(n.id)),
      module: n.id.startsWith("m:") ? n.id.slice(2) : null,
      file: n.id.startsWith("f:") ? n.id.slice(2) : null,
    })),
    edges: spec.edges.map((e) => ({
      from: e.from,
      to: e.to,
      relation: Boolean(edges.find((x) => x.from === e.from && x.to === e.to)?.relation),
      d: sketchEdgePath(byId.get(e.from), byId.get(e.to), seedOf(`${e.from}->${e.to}`)),
    })),
  };
}
