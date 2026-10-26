#!/usr/bin/env node
/**
 * tools/dashboard-shell-client.mjs — оболочка дашборда: материалы, типографическая
 * шкала, движение и три карточки, которых не хватало (что нужно от тебя, слепая
 * приёмка, возраст проверок).
 *
 * Почему отдельным модулем-строкой: шаблон страницы уже на своём потолке размера, и
 * второй растущий блок сдвинул бы потолок вместо того, чтобы его оплатить. Здесь
 * лежит ровно то, что принадлежит оболочке, а не разметке конкретной вкладки.
 */

/* ------------------------------------------------------------------ */
/*  CSS: материалы, шкала, движение, доступность                       */
/* ------------------------------------------------------------------ */

export const SHELL_CSS = String.raw`
  /* ================= materials =================
     Плавающий слой, а не плоская панель: размытие + насыщение, светлая верхняя
     грань (свет ловится на материале), контент прокручивается под ним.
     Вес материала кодирует иерархию: рельс тяжелее шапки, карточка легче обеих. */
  header {
    background: color-mix(in srgb, var(--panel) 72%, transparent);
    backdrop-filter: blur(20px) saturate(180%) brightness(1.04);
    -webkit-backdrop-filter: blur(20px) saturate(180%) brightness(1.04);
    border-bottom: 1px solid color-mix(in srgb, var(--text) 12%, transparent);
    box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 14%, transparent), 0 1px 0 rgba(0,0,0,.25);
  }
  .rail {
    background: color-mix(in srgb, var(--panel) 88%, transparent);
    backdrop-filter: blur(28px) saturate(160%);
    -webkit-backdrop-filter: blur(28px) saturate(160%);
    border-right: 1px solid color-mix(in srgb, var(--text) 10%, transparent);
  }
  .card, .run-tile, .run-gate, .run-words-section, .run-feed-section, .run-waves-section {
    background: color-mix(in srgb, var(--panel) 62%, transparent);
    border: 1px solid color-mix(in srgb, var(--text) 9%, transparent);
    box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent), 0 1px 2px rgba(0,0,0,.18);
  }
  /* Модал — единственное место, где затемнение уместно: задача вытесняет фон.
     Параллельные панели (рельс, лента) живут стеклом без скрима, чтобы поток не рвался. */
  #modal { background: color-mix(in srgb, var(--bg) 58%, transparent); backdrop-filter: blur(3px); }

  /* ================= type scale =================
     Трекинг размерно-зависимый: крупное сжимается, мелкое разжимается, тело — около нуля.
     Один letter-spacing на всё — ошибка в одном из концов шкалы. */
  :root { --step--1: 11.5px; --step-0: 13px; --step-1: 15px; --step-2: 19px; --step-3: 26px; --step-4: clamp(28px, 3.4vw, 40px); }
  body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif; letter-spacing: 0; font-optical-sizing: auto; text-rendering: optimizeLegibility; }
  .display, .hero .pct { font-size: var(--step-4); line-height: 1.02; letter-spacing: -0.022em; font-weight: 700; }
  .title-row h1, .run-hero-title { font-size: var(--step-2); line-height: 1.15; letter-spacing: -0.012em; }
  .run-hero-sentence { font-size: var(--step-0); line-height: 1.5; letter-spacing: 0.002em; }
  .label, .chip, .tag, .run-hero-badge, .run-wip-badge { letter-spacing: 0.055em; }
  .note, .run-step-status, .run-clock-label { letter-spacing: 0.015em; }
  .mono, .v, .run-clock-val { font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
  .v { font-size: var(--step-3); line-height: 1.05; }

  /* ================= motion =================
     Только transform/opacity: компоновка не анимируется, ввод никогда не блокируется.
     Кривая читается как пружина без библиотеки; вход и выход зеркальны. */
  .card, .run-tile, .run-gate, .run-task-card, .run-zone-card, .rail button, .ibtn, .mode-btn {
    transition: transform 180ms cubic-bezier(.32,.72,0,1), background-color 180ms cubic-bezier(.32,.72,0,1), border-color 180ms cubic-bezier(.32,.72,0,1), box-shadow 180ms cubic-bezier(.32,.72,0,1);
  }
  /* Отклик на нажатие, а не на отпускание: обратная связь должна быть мгновенной. */
  .rail button:active, .ibtn:active, .mode-btn:active, .run-filter-btn:active { transform: scale(.97); }
  .run-task-card:hover, .run-zone-card:hover, .card.hoverable:hover { transform: translateY(-1px); }
  .tab.active { animation: shell-in 260ms cubic-bezier(.32,.72,0,1) both; }
  @keyframes shell-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  .run-hero { transition: background-color 220ms cubic-bezier(.32,.72,0,1); }

  /* ================= accessibility =================
     Три независимых сигнала, каждый — полноценная замена, а не отключение обратной связи. */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
    .tab.active { animation: shell-fade 160ms linear both; }
    .run-task-card:hover, .run-zone-card:hover, .card.hoverable:hover { transform: none; }
    .live.on .dot { animation: none; opacity: 1; }
    @keyframes shell-fade { from { opacity: 0 } to { opacity: 1 } }
  }
  @media (prefers-reduced-transparency: reduce) {
    header, .rail, .card, .run-tile, .run-gate, .run-words-section, .run-feed-section, .run-waves-section {
      backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
      background: var(--panel) !important;
    }
    #modal { backdrop-filter: none !important; background: rgba(0,0,0,.62) !important; }
  }
  @media (prefers-contrast: more) {
    header, .rail, .card, .run-tile, .run-gate, .run-words-section, .run-feed-section, .run-waves-section {
      border-color: var(--text) !important; backdrop-filter: none !important; background: var(--panel) !important;
    }
    .chip, .tag, .label, .note { color: var(--text) !important; }
  }

  /* ================= needed / blind / checks ================= */
  .need-block { display: flex; flex-direction: column; gap: 8px; }
  .need-group { border-top: 1px solid color-mix(in srgb, var(--text) 8%, transparent); padding-top: 8px; }
  .need-group:first-child { border-top: 0; padding-top: 0; }
  .need-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: var(--step--1); color: var(--dim); margin-bottom: 6px; }
  .need-head b { color: var(--text); font-variant-numeric: tabular-nums; }
  .need-keys { display: flex; flex-wrap: wrap; gap: 6px; }
  .need-key { font-family: var(--mono); font-size: 11px; padding: 3px 8px; border-radius: 6px; background: color-mix(in srgb, var(--amber) 14%, transparent); border: 1px solid color-mix(in srgb, var(--amber) 34%, transparent); color: var(--amber); }
  .need-item { font-size: var(--step--1); color: var(--text); padding: 3px 0; line-height: 1.45; word-break: break-word; }
  .need-item .where { font-family: var(--mono); color: var(--dim-2); margin-right: 6px; }
  .blind-top { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
  .blind-score { font-family: var(--mono); font-size: var(--step-3); font-weight: 700; letter-spacing: -0.02em; }
  .blind-score small { font-size: var(--step--1); color: var(--dim); font-weight: 500; }
  .blind-mismatch { font-size: var(--step--1); padding: 4px 0; color: var(--amber); line-height: 1.45; }
  .blind-ok { font-size: var(--step--1); color: var(--green); }
  .checks-stale { display: inline-flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 10.5px; padding: 2px 8px; border-radius: 999px; color: var(--amber); background: color-mix(in srgb, var(--amber) 14%, transparent); border: 1px solid color-mix(in srgb, var(--amber) 34%, transparent); }
  .checks-fresh { display: inline-flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 10.5px; padding: 2px 8px; border-radius: 999px; color: var(--green); background: color-mix(in srgb, var(--green) 12%, transparent); border: 1px solid color-mix(in srgb, var(--green) 30%, transparent); }
`;

/* ------------------------------------------------------------------ */
/*  Клиентские карточки                                                */
/* ------------------------------------------------------------------ */

export const SHELL_CLIENT_JS = String.raw`
  /**
   * «Понадобится от тебя»: ключи, заглушки, допущения.
   *
   * Пустое состояние — полноценный ответ («ничего не нужно»), а не пустая рамка:
   * отсутствие карточки читается как «не проверяли».
   */
  function renderNeeded(d) {
    var n = (d.metrics && d.metrics.needed) || null;
    var host = document.getElementById("shell-needed");
    if (!host) return;
    if (!n) { host.style.display = "none"; return; }
    host.style.display = "";
    var env = n.envKeys || [], ph = n.placeholders || [], asm = n.assumptions || [];
    if (!env.length && !ph.length && !asm.length) {
      host.innerHTML = '<div class="label">' + esc(t("neededTitle")) + '</div>' +
        '<div class="note">' + esc(t("neededEmpty")) + "</div>";
      return;
    }
    var keys = env.length
      ? '<div class="need-group"><div class="need-head"><span>' + esc(t("neededKeys")) + "</span><b>" + env.length + "</b></div>" +
        '<div class="need-keys">' + env.map(function (k) { return '<code class="need-key">' + esc(k) + "</code>"; }).join("") + "</div></div>"
      : "";
    var phRows = ph.length
      ? '<div class="need-group"><div class="need-head"><span>' + esc(t("neededPlaceholders")) + "</span><b>" + ph.length + "</b></div>" +
        ph.slice(0, 6).map(function (x) {
          return '<div class="need-item"><span class="where">' + esc(x.file) + ":" + x.line + "</span>" + esc(x.text) + "</div>";
        }).join("") + "</div>"
      : "";
    var asmRows = asm.length
      ? '<div class="need-group"><div class="need-head"><span>' + esc(t("neededAssumptions")) + "</span><b>" + asm.length + "</b></div>" +
        asm.slice(0, 6).map(function (x) { return '<div class="need-item">' + esc(x) + "</div>"; }).join("") + "</div>"
      : "";
    host.innerHTML = '<div class="label">' + esc(t("neededTitle")) + "</div>" +
      '<div class="need-block">' + keys + phRows + asmRows + "</div>";
  }

  /**
   * Слепая приёмка: сколько требований подтверждено и где разошлось.
   *
   * matched / checked — не «процент качества»: это доля РАСПОЗНАННЫХ требований,
   * и подпись говорит именно это, чтобы цифра не читалась как оценка работы.
   */
  function renderBlind(d) {
    var b = (d.metrics && d.metrics.blind) || null;
    var host = document.getElementById("shell-blind");
    if (!host) return;
    if (!b) { host.style.display = "none"; return; }
    host.style.display = "";
    var bad = b.disagreements || [];
    host.innerHTML = '<div class="label">' + esc(t("blindTitle")) + "</div>" +
      '<div class="blind-top"><span class="blind-score">' + esc(String(b.matched)) +
      "<small> / " + esc(String(b.checked)) + "</small></span>" +
      '<span class="note">' + esc(t("blindSub")) + "</span></div>" +
      (bad.length
        ? bad.slice(0, 8).map(function (x) { return '<div class="blind-mismatch">' + esc(x) + "</div>"; }).join("")
        : '<div class="blind-ok">' + esc(t("blindOk")) + "</div>") +
      (b.source ? '<div class="note" style="margin-top:6px">' + esc(b.source) + "</div>" : "");
  }

  /** Возраст автопроверок: зелёное без даты — это тишина, а не результат. */
  function renderChecksAge(d) {
    var a = (d.metrics && d.metrics.checksAge) || null;
    var host = document.getElementById("shell-checks-age");
    if (!host) return;
    if (!a) { host.style.display = "none"; return; }
    host.style.display = "";
    if (a.days === null) {
      host.innerHTML = '<span class="checks-stale">' + esc(t("checksNoDate")) + "</span>";
      return;
    }
    host.innerHTML = a.stale
      ? '<span class="checks-stale">' + esc(t("checksStale")) + " " + a.days + " " + esc(t("daysShort")) + "</span>"
      : '<span class="checks-fresh">' + esc(t("checksFresh")) + "</span>";
  }

  /* Русские и английские подписи трёх карточек. */
`;

export const SHELL_I18N_RU = String.raw`
      neededTitle: "Понадобится от тебя", neededEmpty: "Пока ничего — ключи, заглушки и решения за тебя появятся здесь по ходу",
      neededKeys: "Ключи в .env", neededPlaceholders: "Заглушки — нужны твои данные", neededAssumptions: "Решения, принятые за тебя",
      blindTitle: "Слепая приёмка", blindSub: "распознанных требований из проверенных", blindOk: "Расхождений с твоими словами нет",
      checksStale: "проверки устарели", checksFresh: "проверки свежие", checksNoDate: "проверки без даты", daysShort: "дн.",
`;

export const SHELL_I18N_EN = String.raw`
      neededTitle: "Needed from you", neededEmpty: "Nothing yet — keys, placeholders and decisions made for you will show up here",
      neededKeys: "Keys in .env", neededPlaceholders: "Placeholders — your data needed", neededAssumptions: "Decisions made for you",
      blindTitle: "Blind acceptance", blindSub: "requirements recognised of those checked", blindOk: "No disagreements with your words",
      checksStale: "checks are stale", checksFresh: "checks are fresh", checksNoDate: "checks have no date", daysShort: "days",
`;
