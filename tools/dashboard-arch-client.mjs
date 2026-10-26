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
