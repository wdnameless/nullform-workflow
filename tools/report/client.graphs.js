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
  edgeLayer.innerHTML = edgeHtml.join("\n");

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
  nodeLayer.innerHTML = nodeHtml.join("\n");
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
  edgeLayer.innerHTML = edgeHtml.join("\n");

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

  nodeLayer.innerHTML = nodeHtml.join("\n");
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