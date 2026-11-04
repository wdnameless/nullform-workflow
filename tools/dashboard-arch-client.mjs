#!/usr/bin/env node
/**
 * tools/dashboard-arch-client.mjs — клиентская часть эскиза архитектуры.
 *
 * Живёт отдельным модулем-строкой, а не внутри шаблона дашборда, по одной причине:
 * это единственный кусок клиентского скрипта с состоянием погружения, и его правка
 * не должна раздувать шаблон до размера, при котором гейт размера перестаёт что-либо
 * значить. Возвращается как текст и вставляется в общий <script> без экранирования:
 * кода внутри много, и повторное экранирование сделало бы его нечитаемым в диффе.
 */
export const SKETCH_CLIENT_JS = String.raw`
  /**
   * Вкладка целиком: у эскиза своя панель, свои крошки и свой холст, поэтому он
   * не делит разметку с деревом/графом/таблицей — иначе каждый из четырёх режимов
   * тащит флаги остальных.
   */
  function renderSketchTab(host) {
    host.innerHTML =
      '<div class="map-tools">' +
      '<button class="mode-btn on" data-mode="sketch">' + t("viewSketch") + "</button>" +
      '<button class="mode-btn" data-mode="tree">' + t("viewTree") + "</button>" +
      '<button class="mode-btn" data-mode="graph">' + t("viewGraph") + "</button>" +
      '<button class="mode-btn" data-mode="table">' + t("viewTable") + "</button>" +
      sketchToolbar() +
      '<span class="chip">' + t("files") + " <b>" + num(DATA.arch.files) + "</b> · " + t("lines") + " <b>" + num(DATA.arch.lines) + "</b></span>" +
      "</div>" +
      '<div class="arch-body"><div><div class="crumbs" id="arch-crumbs"></div><div class="map-wrap" id="arch-canvas"></div></div>' +
      '<aside class="panel" id="arch-panel"></aside></div>';
    host.querySelectorAll(".mode-btn").forEach(function (b) {
      b.addEventListener("click", function () { setArchMode(b.getAttribute("data-mode")); });
    });
    var xe = host.querySelector(".sk-export");
    if (xe) xe.addEventListener("click", function () { downloadSketch(); });
    var inp = document.getElementById("arch-filter");
    if (inp) inp.addEventListener("input", function () { archFilter = inp.value; drawArch(); });
    drawSketch();
    renderPanel();
  }

  /**
   * Esc сначала поднимает на уровень выше и только потом закрывает модал:
   * иначе один промах по клавише уносит и погружение, и открытый diff.
   */
  function onEscape(e) {
    if (e.key !== "Escape") return;
    var modalOpen = document.getElementById("modal").classList.contains("open");
    if (!modalOpen && TAB === "arch" && ARCH_MODE === "sketch" && (DRILL.module || DRILL.file)) { skUp(-1); return; }
    if (modalOpen) closeModal();
  }

  /** Кнопка экспорта и подсказка — часть режима, поэтому живут с ним. */
  function sketchToolbar() {
    return '<button class="sk-export">' + t("sketchExport") + '</button><span class="chip">' + t("sketchHint") + "</span>";
  }

  /* --- режим 4: эскиз с погружением (проект → модуль → файл → символы) --- */
  var DRILL = { module: null, file: null };
  var skCache = { key: null, value: null };

  function drillDrill() { return DATA.archDrill || { name: DATA.arch.name, files: DATA.arch.files, lines: DATA.arch.lines, modules: [] }; }

  /** Локальная раскладка — только для мгновенного отклика, без сервера. */
  function localSketch() {
    var d = drillDrill();
    var mod = DRILL.module ? (d.modules || []).filter(function (m) { return m.name === DRILL.module; })[0] : null;
    var fileNode = mod && DRILL.file ? (mod.children || []).filter(function (f) { return f.path === DRILL.file; })[0] : null;
    if (fileNode) return { level: "file", crumbs: [{ label: d.name }, { label: mod.name, module: mod.name }, { label: fileNode.path.split("/").pop(), module: mod.name, file: DRILL.file }], nodes: [], edges: [] };
    if (mod) return { level: "module", crumbs: [{ label: d.name }, { label: mod.name, module: mod.name }], nodes: [], edges: [] };
    return { level: "project", crumbs: [{ label: d.name }], nodes: [], edges: [] };
  }

  function skCacheKey() { return [DRILL.module || "", DRILL.file || "", (DATA.archDrill || {}).name || "", (DATA.archDrill || {}).files || 0, DATA.timestamp || ""].join("|"); }

  function drawSketch() {
    var canvas = document.getElementById("arch-canvas");
    var crumbBox = document.getElementById("arch-crumbs");
    var view = localSketch();
    if (crumbBox) {
      crumbBox.innerHTML = view.crumbs.map(function (c, i) {
        var last = i === view.crumbs.length - 1;
        var el = last
          ? '<span class="here">' + esc(c.label) + "</span>"
          : '<button data-i="' + i + '">' + esc(c.label) + "</button>";
        return (i ? '<span class="sep"> › </span>' : "") + el;
      }).join("") + (view.level !== "project" ? '<span class="sep"> · </span><button data-i="-1">' + t("sketchBack") + "</button>" : "");
      crumbBox.querySelectorAll("button").forEach(function (b) {
        b.addEventListener("click", function () { skUp(Number(b.getAttribute("data-i"))); });
      });
    }

    // Геометрию считает сервер — она же уходит в .excalidraw. Клиент только рисует.
    var key = skCacheKey();
    if (skCache.key === key && skCache.value) { paintSketch(skCache.value, view); return; }
    skCache = { key: key, value: null };
    var q = [];
    if (DRILL.module) q.push("module=" + encodeURIComponent(DRILL.module));
    if (DRILL.file) q.push("file=" + encodeURIComponent(DRILL.file));
    fetch("/api/arch.sketch" + (q.length ? "?" + q.join("&") : ""), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) {
        var sig = s ? s.nodes.length + "|" + s.w + "x" + s.h + "|" + s.nodes.map(function (n) { return n.id; }).join(",") : "";
        if (skCache.value && skCache.sig === sig) return; // уровень не изменился — не мигаем
        skCache.value = s;
        skCache.sig = sig;
        paintSketch(s, view);
      })
      .catch(function () { paintSketch(null, view); });
  }

  function paintSketch(sketch, view) {
    var canvas = document.getElementById("arch-canvas");
    if (!sketch || !sketch.nodes || !sketch.nodes.length) {
      canvas.innerHTML = '<div class="empty" style="padding:20px">' + t("sketchEmpty") + "</div>";
      return;
    }
    var edges = (sketch.edges || []).map(function (e) {
      return '<path class="sk-edge' + (e.relation ? " rel" : "") + '" d="' + e.d + '"></path>';
    }).join("");
    var boxes = (sketch.nodes || []).map(function (n) {
      var fill = n.fill || "transparent";
      var kids = n.module ? " data-module='" + esc(n.module) + "'" : (n.file ? " data-file='" + esc(n.file) + "'" : "");
      return '<g class="sk-box" data-id="' + esc(n.id) + '"' + kids + ">" +
        '<path class="fill" d="' + n.box + '" fill="' + esc(fill) + '" fill-opacity=".5"></path>' +
        '<path class="ink" d="' + n.box + '"></path>' +
        '<path class="ink2" d="' + n.box + '" transform="translate(1.2,1.1)"></path>' +
        '<text x="' + (n.x + 10) + '" y="' + (n.y + 21) + '">' + esc(n.label) + "</text>" +
        (n.sub ? '<text class="sub" x="' + (n.x + 10) + '" y="' + (n.y + 37) + '">' + esc(n.sub) + "</text>" : "") +
        "</g>";
    }).join("");
    canvas.innerHTML = '<svg class="map sketch" width="' + sketch.w + '" height="' + sketch.h + '" viewBox="0 0 ' + sketch.w + " " + sketch.h + '">' + edges + boxes + "</svg>";
    canvas.querySelectorAll("g.sk-box").forEach(function (g) {
      g.addEventListener("click", function () {
        var mod = g.getAttribute("data-module");
        var file = g.getAttribute("data-file");
        if (mod) { DRILL = { module: mod, file: null }; renderArch(); }
        else if (file) { DRILL = { module: DRILL.module, file: file }; renderArch(); }
      });
    });
  }

  /** Возврат на уровень: i — индекс крошки, -1 — на один уровень вверх. */
  function skUp(i) {
    if (i === -1) {
      if (DRILL.file) DRILL = { module: DRILL.module, file: null };
      else if (DRILL.module) DRILL = { module: null, file: null };
    } else if (i === 0) {
      DRILL = { module: null, file: null };
    } else if (i === 1) {
      DRILL = { module: DRILL.module, file: null };
    }
    skCache = { key: null, value: null };
    renderArch();
  }

  function downloadSketch() {
    var q = [];
    if (DRILL.module) q.push("module=" + encodeURIComponent(DRILL.module));
    if (DRILL.file) q.push("file=" + encodeURIComponent(DRILL.file));
    window.location.href = "/api/arch.excalidraw" + (q.length ? "?" + q.join("&") : "");
  }
`;


/** CSS эскиза: рукописный штрих, подсветка и крошки. Вставляется в <style>. */
export const SKETCH_CSS = String.raw`
  /* ---------- sketch (hand-drawn) ---------- */
  .sk-box { cursor: pointer; }
  .sk-box path.fill { stroke: none; }
  .sk-box path.ink { fill: none; stroke: var(--text); stroke-width: 1.4; stroke-linejoin: round; opacity: .85; }
  .sk-box path.ink2 { fill: none; stroke: var(--text); stroke-width: .7; stroke-linejoin: round; opacity: .35; }
  .sk-box:hover path.ink, .sk-box.sel path.ink { stroke: var(--lime); stroke-width: 2; }
  .sk-box text { fill: var(--text); font-family: var(--mono); font-size: 12px; pointer-events: none; }
  .sk-box .sub { fill: var(--dim-2); font-size: 10px; }
  .sk-box:hover .sub { fill: var(--dim); }
  .sk-edge { fill: none; stroke: var(--dim-2); stroke-width: 1.2; opacity: .5; }
  .sk-edge.rel { stroke-dasharray: 5 4; }
  .sk-edge:hover { stroke: var(--lime); opacity: .95; }
  .crumbs { display: flex; gap: 6px; align-items: center; font-family: var(--mono); font-size: 11.5px; color: var(--dim); margin-bottom: 8px; flex-wrap: wrap; }
  .crumbs button { background: none; border: 0; color: var(--lime); cursor: pointer; font-family: inherit; font-size: inherit; padding: 0; }
  .crumbs .sep { color: var(--dim-2); }
  .crumbs .here { color: var(--text); }
  body.light .sk-box path.fill { opacity: .28; }
`;

/**
 * Подписи режима как ИСХОДНИК объекта, а не объект.
 *
 * Шаблон дашборда — это template literal, и `${object}` даёт "[object Object]".
 * Отдаём готовый текст полей, чтобы вставка была буквальной.
 */
export const SKETCH_I18N_RU = String.raw`
      viewSketch: "Эскиз", sketchExport: "Скачать .excalidraw", sketchRoot: "проект",
      sketchSymbols: "символов", sketchMore: "ещё", sketchEmpty: "Файлов для показа нет",
      sketchHint: "клик по узлу — погружение на уровень ниже · Esc — на уровень выше",
      sketchLevelProject: "уровень: проект", sketchLevelModule: "уровень: модуль", sketchLevelFile: "уровень: файл",
      sketchBack: "назад", sketchRelation: "связь между модулями",
`;

export const SKETCH_I18N_EN = String.raw`
      viewSketch: "Sketch", sketchExport: "Download .excalidraw", sketchRoot: "project",
      sketchSymbols: "symbols", sketchMore: "more", sketchEmpty: "Nothing to show at this level",
      sketchHint: "click a node to go deeper · Esc to go up a level",
      sketchLevelProject: "level: project", sketchLevelModule: "level: module", sketchLevelFile: "level: file",
      sketchBack: "back", sketchRelation: "module-to-module link",
`;

export const ARCH_CLIENT_JS = String.raw`  /* ===================== architecture: 3 modes ===================== */
  var ARCH_MODE = localStorage.getItem("nf-arch-mode") || "tree";
  var archFilter = "";
  var selectedNode = null;
  var zoom = 1;
  var collapsed = null;

  function archNodes() { return (DATA.archGraph && DATA.archGraph.nodes) || []; }
  function archEdges() { return (DATA.archGraph && DATA.archGraph.edges) || []; }
  function nodeById(id) { return archNodes().filter(function (n) { return n.id === id; })[0] || null; }
  function matchesFilter(id) { return !archFilter || id.toLowerCase().indexOf(archFilter.toLowerCase()) >= 0; }

  function renderArch() {
    var host = document.getElementById("tab-arch");
    if (ARCH_MODE === "sketch") { renderSketchTab(host); return; }
    var modes = [["tree", t("viewTree")], ["graph", t("viewGraph")], ["table", t("viewTable")]];
    host.innerHTML =
      '<div class="map-tools">' +
      modes.map(function (m) {
        // Без inline-onclick: кавычки внутри шаблона ломали клиентский скрипт.
        return '<button class="mode-btn' + (ARCH_MODE === m[0] ? " on" : "") + '" data-mode="' + m[0] + '">' + m[1] + "</button>";
      }).join("") +
      '<input id="arch-filter" class="inp" placeholder="' + t("filter") + '" value="' + esc(archFilter) + '">' +
      (ARCH_MODE === "tree" ? '<button class="exp-btn" data-collapse="1">' + t("collapseAll") + '</button><button class="exp-btn" data-collapse="0">' + t("expandAll") + "</button>" : "") +
      (ARCH_MODE === "graph" ? '<span class="chip">' + t("zoom") + ': <b id="zoom-val">' + Math.round(zoom * 100) + '%</b></span><button class="zoom-reset">' + t("reset") + "</button>" : "") +
      '<span class="chip">' + t("files") + " <b>" + num(DATA.arch.files) + "</b> · " + t("lines") + " <b>" + num(DATA.arch.lines) + "</b></span>" +
      "</div>" +
      '<div class="arch-body"><div class="map-wrap" id="arch-canvas"></div><aside class="panel" id="arch-panel"></aside></div>';

    host.querySelectorAll(".mode-btn").forEach(function (b) {
      b.addEventListener("click", function () { setArchMode(b.getAttribute("data-mode")); });
    });
    host.querySelectorAll(".exp-btn").forEach(function (b) {
      b.addEventListener("click", function () { mapExpandAll(b.getAttribute("data-collapse") === "1"); });
    });
    var zr = host.querySelector(".zoom-reset");
    if (zr) zr.addEventListener("click", function () { setZoom(1); });
    var inp = document.getElementById("arch-filter");
    if (inp) inp.addEventListener("input", function () { archFilter = inp.value; drawArch(); });

    if (ARCH_MODE === "tree") drawTree();
    else if (ARCH_MODE === "graph") drawGraph();
    else drawTable();
    renderPanel();
  }
  function setArchMode(m) { ARCH_MODE = m; localStorage.setItem("nf-arch-mode", m); renderArch(); }
  function setZoom(z) { zoom = Math.max(0.4, Math.min(2.5, z)); var el = document.getElementById("zoom-val"); if (el) el.textContent = Math.round(zoom * 100) + "%"; drawGraph(); }
  function drawArch() { if (TAB === "arch") renderArch(); }`;

export const ARCH_MODES_JS = String.raw`
  /* --- режим 1: схема (дерево) --- */
  function visibleTree(node) {
    if (!collapsed) {
      collapsed = {};
      (DATA.arch.children || []).forEach(function (c) { collapsed[c.name] = true; });
    }
    if (collapsed[node.name]) return { name: node.name, kind: node.kind, lines: node.lines, files: node.files, children: [] };
    return { name: node.name, kind: node.kind, lines: node.lines, files: node.files, children: (node.children || []).map(visibleTree) };
  }
  function treeLayout(node) {
    var rowH = 26, xGap = 230, cursor = 0, nodes = [], links = [];
    (function walk(n, depth, parent) {
      var kids = n.children || [];
      var y = cursor * rowH;
      if (kids.length === 0) { cursor += 1; y = (cursor - 1) * rowH; }
      var me = { x: depth * xGap, y: y, node: n, depth: depth };
      nodes.push(me);
      if (parent) links.push([parent, me]);
      if (kids.length) {
        var first = null, last = null;
        kids.forEach(function (k) { var c = walk(k, depth + 1, me); if (!first) first = c; last = c; });
        me.y = (first.y + last.y) / 2;
      }
      return me;
    })(node, 0, null);
    return { nodes: nodes, links: links, height: Math.max(1, cursor) * rowH + 30 };
  }
  function drawTree() {
    var canvas = document.getElementById("arch-canvas");
    var tree = visibleTree(DATA.arch);
    var lay = treeLayout(tree);
    var longest = 0;
    lay.nodes.forEach(function (n) { if (String(n.node.name).length > longest) longest = String(n.node.name).length; });
    var boxW = Math.min(300, Math.max(140, longest * 7.2 + 30)), boxH = 22;
    var maxX = 0;
    lay.nodes.forEach(function (n) { if (n.x > maxX) maxX = n.x; });
    var W = (maxX + boxW + 40) * zoom, H = lay.height * zoom;

    var links = lay.links.map(function (p) {
      var a = p[0], b = p[1];
      var x1 = a.x + boxW, y1 = a.y + boxH / 2, x2 = b.x, y2 = b.y + boxH / 2, mx = (x1 + x2) / 2;
      return '<path class="link" d="M' + x1 + " " + y1 + " C" + mx + " " + y1 + ", " + mx + " " + y2 + ", " + x2 + " " + y2 + '"></path>';
    }).join("");

    var nodes = lay.nodes.map(function (n) {
      var nd = n.node, kids = (nd.children || []).length;
      var dim = !matchesFilter(nd.name) ? " dim" : "";
      var cls = "node " + (nd.kind || "other") + (collapsed[nd.name] ? " collapsed" : "") + dim + (selectedNode === nd.name ? " sel" : "");
      var meta = nd.kind === "file" ? num(nd.lines) + " " + t("lines") : num(nd.files) + " " + t("files") + " · " + num(nd.lines) + " " + t("lines");
      return '<g class="' + cls + '" transform="translate(' + n.x + "," + n.y + ')" data-name="' + esc(nd.name) + '">' +
        '<rect width="' + boxW + '" height="' + boxH + '" rx="7"></rect>' +
        '<text x="10" y="15">' + esc(nd.name) + (kids ? (collapsed[nd.name] ? " ▸" : " ▾") : "") + "</text>" +
        '<title>' + esc(nd.name) + " — " + esc(meta) + "</title></g>";
    }).join("");

    canvas.innerHTML = '<svg class="map" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W / zoom + " " + H / zoom + '">' + links + nodes + "</svg>";
    canvas.querySelectorAll("g.node").forEach(function (g) {
      g.addEventListener("click", function () {
        var nm = g.getAttribute("data-name");
        if (selectedNode === nm) { collapsed[nm] = !collapsed[nm]; } else { selectedNode = nm; }
        renderArch();
      });
    });
  }
  function mapExpandAll(collapse) {
    collapsed = {};
    if (collapse) (DATA.arch.children || []).forEach(function (c) { collapsed[c.name] = true; });
    renderArch();
  }

  /* --- режим 2: граф зависимостей --- */
  function drawGraph() {
    var canvas = document.getElementById("arch-canvas");
    var nodes = archNodes().filter(function (n) { return matchesFilter(n.id); });
    var ids = {};
    nodes.forEach(function (n) { ids[n.id] = true; });
    var edges = archEdges().filter(function (e) { return ids[e.from] && ids[e.to]; });

    // Слои: BFS от узла с максимумом исходящих связей (обычно «tools»).
    var roots = nodes.slice().sort(function (a, b) { return b.outWeight - a.outWeight; });
    var level = {};
    var queue = [];
    if (roots[0]) { level[roots[0].id] = 0; queue.push(roots[0].id); }
    while (queue.length) {
      var cur = queue.shift();
      edges.filter(function (e) { return e.from === cur; }).forEach(function (e) {
        if (level[e.to] === undefined) { level[e.to] = (level[cur] || 0) + 1; queue.push(e.to); }
      });
    }
    var maxLevel = 0;
    nodes.forEach(function (n) { if (level[n.id] === undefined) level[n.id] = 0; if (level[n.id] > maxLevel) maxLevel = level[n.id]; });

    var byLevel = {};
    nodes.forEach(function (n) { (byLevel[level[n.id]] = byLevel[level[n.id]] || []).push(n); });
    var colW = 250, rowH = 84, boxW = 180, boxH = 40, pad = 30;
    var maxRows = Math.max.apply(null, Object.keys(byLevel).map(function (k) { return byLevel[k].length; }).concat([1]));
    var W = (maxLevel + 1) * colW + pad * 2, H = maxRows * rowH + pad * 2;
    var pos = {};
    Object.keys(byLevel).forEach(function (lv) {
      byLevel[lv].forEach(function (n, i) {
        pos[n.id] = { x: pad + Number(lv) * colW, y: pad + i * rowH + (H - byLevel[lv].length * rowH) / 2 };
      });
    });

    var maxWeight = Math.max.apply(null, edges.map(function (e) { return e.weight; }).concat([1]));
    var links = edges.map(function (e) {
      var a = pos[e.from], b = pos[e.to];
      if (!a || !b) return "";
      var x1 = a.x + boxW, y1 = a.y + boxH / 2, x2 = b.x, y2 = b.y + boxH / 2;
      var mx = (x1 + x2) / 2;
      var w = 1 + 3 * (e.weight / maxWeight);
      var hot = selectedNode && (e.from === selectedNode || e.to === selectedNode);
      return '<path class="edge' + (hot ? " hot" : "") + '" d="M' + x1 + " " + y1 + " C" + mx + " " + y1 + ", " + mx + " " + y2 + ", " + x2 + " " + y2 + '" stroke-width="' + w.toFixed(1) + '"></path>' +
        '<text class="edge-w" x="' + mx + '" y="' + ((y1 + y2) / 2 - 4) + '">' + e.weight + "</text>";
    }).join("");

    var boxes = nodes.map(function (n) {
      var p = pos[n.id];
      var dim = !matchesFilter(n.id) ? " dim" : "";
      return '<g class="gnode ' + esc(n.id.split("/")[0]) + dim + (selectedNode === n.id ? " sel" : "") + '" transform="translate(' + p.x + "," + p.y + ')" data-name="' + esc(n.id) + '">' +
        '<rect width="' + boxW + '" height="' + boxH + '" rx="8"></rect>' +
        '<text x="12" y="17">' + esc(n.id) + "</text>" +
        '<text class="meta" x="12" y="31">' + num(n.files) + " " + t("files") + " · " + num(n.lines) + " " + t("lines") + "</text>" +
        '<title>' + esc(n.id) + "</title></g>";
    }).join("");

    canvas.innerHTML = '<svg class="map graph" width="' + W * zoom + '" height="' + H * zoom + '" viewBox="0 0 ' + W + " " + H + '">' + links + boxes + "</svg>";
    canvas.querySelectorAll("g.gnode").forEach(function (g) {
      g.addEventListener("click", function () { selectedNode = g.getAttribute("data-name"); renderArch(); });
    });
  }

  /* --- режим 3: таблица --- */
  function drawTable() {
    var canvas = document.getElementById("arch-canvas");
    var rows = archNodes().filter(function (n) { return matchesFilter(n.id); }).sort(function (a, b) { return b.lines - a.lines; });
    var out = rows.map(function (n) {
      var ins = archEdges().filter(function (e) { return e.to === n.id; }).map(function (e) { return e.from; });
      var outs = archEdges().filter(function (e) { return e.from === n.id; }).map(function (e) { return e.to; });
      return '<div class="row' + (selectedNode === n.id ? " sel" : "") + '" data-name="' + esc(n.id) + '" style="cursor:pointer">' +
        '<span class="grow mono">' + esc(n.id) + "</span>" +
        '<span class="mono" style="color:var(--dim)">' + num(n.files) + " " + t("files") + " · " + num(n.lines) + " " + t("lines") + "</span>" +
        '<span class="chip">→ ' + (outs.length ? esc(outs.join(", ")) : t("noDeps")) + "</span>" +
        '<span class="chip">← ' + (ins.length ? esc(ins.join(", ")) : t("noDeps")) + "</span></div>";
    }).join("");
    canvas.innerHTML = '<div class="card" style="border:0;padding:4px 0">' + (out || '<div class="empty">' + t("empty") + "</div>") + "</div>";
    canvas.querySelectorAll(".row").forEach(function (r) {
      r.addEventListener("click", function () { selectedNode = r.getAttribute("data-name"); renderArch(); });
    });
  }

  /* --- панель деталей --- */
  function renderPanel() {
    var panel = document.getElementById("arch-panel");
    if (!selectedNode) { panel.innerHTML = '<div class="label">' + t("details") + '</div><div class="empty">' + t("selectNode") + "</div>"; return; }
    var n = nodeById(selectedNode);
    var fileNode = null;
    (function find(node) {
      if (!node || fileNode) return;
      if (node.name === selectedNode && node.kind === "file") fileNode = node;
      (node.children || []).forEach(find);
    })(DATA.arch);

    var ins = archEdges().filter(function (e) { return e.to === selectedNode; });
    var outs = archEdges().filter(function (e) { return e.from === selectedNode; });
    var body = "";
    if (fileNode) {
      body = '<div class="kv"><span>' + t("lines") + "</span><b>" + num(fileNode.lines) + "</b></div>" +
        '<div class="kv"><span>' + t("kindCode") + "</span><b>" + esc(fileNode.path || selectedNode) + "</b></div>";
    } else if (n) {
      body =
        '<div class="kv"><span>' + t("files") + "</span><b>" + num(n.files) + "</b></div>" +
        '<div class="kv"><span>' + t("lines") + "</span><b>" + num(n.lines) + "</b></div>" +
        '<div class="kv"><span>' + t("external") + "</span><b>" + num(n.external) + "</b></div>" +
        '<div class="label" style="margin-top:12px">' + t("outgoing") + "</div>" +
        (outs.length ? outs.map(function (e) { return '<div class="kv"><span class="mono">' + esc(e.to) + '</span><b>' + e.weight + ' <span class="note">' + e.kinds.map(function (k) { return t("dep" + k.charAt(0).toUpperCase() + k.slice(1)); }).join("/") + "</span></b></div>"; }).join("") : '<div class="empty">' + t("noDeps") + "</div>") +
        '<div class="label" style="margin-top:12px">' + t("incoming") + "</div>" +
        (ins.length ? ins.map(function (e) { return '<div class="kv"><span class="mono">' + esc(e.from) + "</span><b>" + e.weight + "</b></div>"; }).join("") : '<div class="empty">' + t("noDeps") + "</div>") +
        (n.topFiles.length ? '<div class="label" style="margin-top:12px">' + t("topFiles") + "</div>" + n.topFiles.map(function (f) { return '<div class="kv"><span class="mono" style="font-size:11px">' + esc(f) + "</span></div>"; }).join("") : "");
    }
    panel.innerHTML = '<div class="label">' + t("details") + "</div>" + body;
  }`;
