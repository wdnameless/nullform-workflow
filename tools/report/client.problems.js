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
  const m = tf ? tf.match(/translate(([^,]+),([^)]+))/) : null;
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
