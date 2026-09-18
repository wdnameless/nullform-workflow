/*__ARCHMAP_DATA__*/
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
  const norm = String(p || "").replace(/\\/g, "/");
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
    edgeLayer.innerHTML = edgeHtml.join("\n");

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
    nodeLayer.innerHTML = nodeHtml.join("\n");
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
  edgeLayer.innerHTML = edgeHtml.join("\n");

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
  nodeLayer.innerHTML = nodeHtml.join("\n");
}

/* Render Function Calls Graph Mode */