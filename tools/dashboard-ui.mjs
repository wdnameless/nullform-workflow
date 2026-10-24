#!/usr/bin/env node
/**
 * tools/dashboard-ui.mjs — HTML-шаблон дашборда (выделен из dashboard.mjs 1:1).
 * Чистая функция data -> html, без node-зависимостей.
 */

/**
 * Автономная страница «Nullform Console»: серверный каркас + клиентский рендер.
 *
 * Свой стиль (не копия Autopilot): тёмный консольный холст по умолчанию,
 * лаймовый акцент, монопространственные значения, левый рельс вкладок.
 * Вкладки: Обзор · Архитектура (майндкарта) · Логи сессии · Диффы · Критика · Долг · История.
 * Данные приходят из `/api/state` каждые 3 с и перерисовываются на месте.
 */
export function esc(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function generateDashboardHtml(data, options = {}) {
  const isFrozen = Boolean(options.frozen);
  const rawPollMs = Number(options.pollMs);
  const pollMs = Number.isFinite(rawPollMs)
    ? Math.min(3000, Math.max(1000, Math.round(rawPollMs)))
    : 2000;
  const payload = JSON.stringify(data).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nullform Console · ${esc(data.project && data.project.name)}</title>
<style>
  :root {
    --bg: #0b0e14; --panel: #11151f; --panel-2: #161b28; --line: #232a3a; --line-soft: #1a2030;
    --text: #e6ebf5; --dim: #8b94a7; --dim-2: #5d6779;
    --lime: #b8ff2e; --lime-dim: #7fae1f; --green: #10b981; --amber: #ffb545; --red: #ff5f56; --blue: #6ea8fe; --violet: #c58fff;
    --mono: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --r: 10px;
  }
  body.light {
    --bg: #f7f8fa; --panel: #ffffff; --panel-2: #f2f4f7; --line: #e2e6ee; --line-soft: #edf0f5;
    --text: #10141c; --dim: #5f6878; --dim-2: #98a1b0;
    --lime: #5f8f00; --lime-dim: #7fae1f; --green: #059669;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--sans); background: var(--bg); color: var(--text); line-height: 1.45; }
  .mono { font-family: var(--mono); font-size: 12px; }
  a { color: var(--lime); }

  /* ---------- top bar ---------- */
  header { display: flex; align-items: center; gap: 14px; padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--panel); position: sticky; top: 0; z-index: 20; }
  .brand { display: flex; align-items: baseline; gap: 7px; font-weight: 800; letter-spacing: -0.3px; font-size: 17px; }
  .brand .x { color: var(--lime); font-weight: 900; }
  .brand .sub { font-size: 12px; font-weight: 500; color: var(--dim); letter-spacing: 0.4px; text-transform: uppercase; }
  .chip { font-family: var(--mono); font-size: 11px; padding: 3px 9px; border: 1px solid var(--line); border-radius: 999px; color: var(--dim); white-space: nowrap; }
  .chip b { color: var(--text); font-weight: 600; }
  .spacer { flex: 1; }
  .live { display: inline-flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 11px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line); color: var(--dim); }
  .live.on { color: var(--lime); border-color: color-mix(in srgb, var(--lime) 45%, transparent); }
  .live .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dim-2); }
  .live.on .dot { background: var(--lime); animation: pulse 1.6s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .2 } }
  .ibtn { width: 30px; height: 30px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel-2); color: var(--text); cursor: pointer; font-size: 13px; }
  .ibtn:hover { border-color: var(--dim-2); }
  .seg { display: flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .seg button { border: 0; background: var(--panel-2); color: var(--dim); padding: 5px 9px; cursor: pointer; font-family: var(--mono); font-size: 11px; }
  .seg button.active { background: var(--lime); color: #0b0e14; font-weight: 700; }

  /* ---------- layout: rail + content ---------- */
  .shell { display: grid; grid-template-columns: 208px 1fr; min-height: calc(100vh - 55px); }
  @media (max-width: 900px) { .shell { grid-template-columns: 1fr; } .rail { display: flex; overflow-x: auto; } }
  .rail { border-right: 1px solid var(--line); background: var(--panel); padding: 14px 10px; }
  .rail button { display: flex; align-items: center; gap: 9px; width: 100%; text-align: left; padding: 9px 11px; margin-bottom: 3px; border: 0; border-radius: 8px; background: transparent; color: var(--dim); cursor: pointer; font-size: 13px; }
  .rail button:hover { background: var(--panel-2); color: var(--text); }
  .rail button.active { background: var(--panel-2); color: var(--text); box-shadow: inset 2px 0 0 var(--lime); }
  .rail .ico { width: 16px; text-align: center; opacity: .9; }
  .rail .badge-n { margin-left: auto; font-family: var(--mono); font-size: 10px; color: var(--dim-2); }
  .content { padding: 20px 22px 60px; max-width: 1400px; }
  .tab { display: none; }
  .tab.active { display: block; }

  /* ---------- cards & metrics ---------- */
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r); padding: 16px 18px; }
  .label { font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.9px; text-transform: uppercase; color: var(--dim-2); margin-bottom: 8px; }
  .grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 14px; }
  @media (max-width: 1100px) { .grid4 { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 620px) { .grid4 { grid-template-columns: 1fr; } }
  .v { font-family: var(--mono); font-size: 24px; font-weight: 700; letter-spacing: -0.5px; }
  .v.sm { font-size: 16px; }
  .note { font-size: 11.5px; color: var(--dim); margin-top: 3px; }
  .bar { height: 8px; background: var(--line-soft); border-radius: 99px; overflow: hidden; margin: 12px 0 7px; }
  .bar > i { display: block; height: 100%; background: var(--lime); transition: width .6s ease; }
  .bar.mini { height: 5px; margin: 7px 0 5px; }
  .bar.mini > i { background: var(--blue); }
  .hero { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
  .hero .pct { font-family: var(--mono); font-size: 40px; font-weight: 800; letter-spacing: -2px; line-height: 1; }
  .title-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
  .title-row h1 { font-size: 17px; font-weight: 700; }
  .tag { font-family: var(--mono); font-size: 10.5px; padding: 3px 9px; border-radius: 6px; border: 1px solid var(--line); color: var(--dim); text-transform: uppercase; letter-spacing: .5px; }
  .tag.on { color: var(--lime); border-color: color-mix(in srgb, var(--lime) 40%, transparent); }
  .tag.warn { color: var(--amber); border-color: color-mix(in srgb, var(--amber) 40%, transparent); }

  /* ---------- stages / waves ---------- */
  .stage { display: flex; align-items: center; gap: 11px; padding: 9px 2px; border-bottom: 1px solid var(--line-soft); font-size: 13px; }
  .stage:last-child { border-bottom: 0; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--line); flex: 0 0 auto; }
  .stage.done .dot { background: var(--lime); }
  .stage.active .dot { background: var(--amber); box-shadow: 0 0 0 4px color-mix(in srgb, var(--amber) 20%, transparent); }
  .stage.skipped .dot { background: transparent; border: 1px dashed var(--line); }
  .stage.missed .dot { background: var(--red); }
  .stage.skipped .nm { color: var(--dim-2); }
  .stage .nm { flex: 1; }
  .stage .tm { font-family: var(--mono); font-size: 11px; color: var(--dim); }
  .stage-note { color: var(--dim-2); font-size: 11.5px; }
  .wave-title { font-family: var(--mono); font-size: 10.5px; letter-spacing: .8px; text-transform: uppercase; color: var(--dim-2); margin: 14px 0 7px; }
  .task { display: flex; align-items: center; gap: 9px; margin-bottom: 5px; }
  .task .idx { font-family: var(--mono); font-size: 10px; color: var(--dim-2); width: 18px; }
  .task .b { flex: 1; padding: 6px 11px; border-radius: 7px; font-size: 12.5px; font-weight: 600; }
  .task .b.done { background: color-mix(in srgb, var(--lime) 18%, transparent); color: var(--lime); border: 1px solid color-mix(in srgb, var(--lime) 30%, transparent); }
  .task .b.active { background: color-mix(in srgb, var(--amber) 18%, transparent); color: var(--amber); border: 1px solid color-mix(in srgb, var(--amber) 32%, transparent); }
  .task .b.pending { background: var(--panel-2); color: var(--dim); border: 1px solid var(--line-soft); }
  .task .b.skipped { background: transparent; color: var(--dim-2); border: 1px dashed var(--line); font-weight: 500; }
  .task .t { font-family: var(--mono); font-size: 11px; color: var(--dim); width: 66px; text-align: right; }

  /* ---------- lists ---------- */
  .row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--line-soft); font-size: 12.5px; }
  .row:last-child { border-bottom: 0; }
  .row .grow { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pill { font-family: var(--mono); font-size: 10px; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--line); color: var(--dim); }
  .pill.ok { color: var(--lime); border-color: color-mix(in srgb, var(--lime) 35%, transparent); }
  .pill.bad { color: var(--red); border-color: color-mix(in srgb, var(--red) 35%, transparent); }
  .pill.warn { color: var(--amber); border-color: color-mix(in srgb, var(--amber) 35%, transparent); }
  .add { color: var(--lime); } .del { color: var(--red); }
  .empty { color: var(--dim-2); font-size: 12.5px; padding: 10px 0; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 1000px) { .two { grid-template-columns: 1fr; } }
  .stack { display: grid; gap: 14px; }

  /* ---------- logs ---------- */
  .log { font-family: var(--mono); font-size: 11.5px; max-height: 62vh; overflow: auto; }
  .log .ln { display: grid; grid-template-columns: 66px 92px 1fr; gap: 10px; padding: 4px 0; border-bottom: 1px solid var(--line-soft); }
  .log .ts { color: var(--dim-2); }
  .log .k { color: var(--blue); }
  .log .k.tool { color: var(--violet); }
  .log .k.error { color: var(--red); }
  .log .k.notice { color: var(--amber); }
  .log .k.user { color: var(--lime); }
  .log .tx { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .log .tx.err { color: var(--red); }

  /* ---------- mindmap ---------- */
  .map-wrap { position: relative; overflow: auto; border: 1px solid var(--line); border-radius: var(--r); background: var(--panel); }
  .map-tools { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
  .map-tools button { font-family: var(--mono); font-size: 11px; padding: 5px 10px; border-radius: 7px; border: 1px solid var(--line); background: var(--panel-2); color: var(--dim); cursor: pointer; }
  .map-tools button:hover { color: var(--text); }
  svg.map { display: block; }
  .map .link { fill: none; stroke: var(--line); stroke-width: 1.4; }
  .map .node rect { fill: var(--panel-2); stroke: var(--line); rx: 8; }
  .map .node.root rect { fill: color-mix(in srgb, var(--lime) 16%, var(--panel-2)); stroke: color-mix(in srgb, var(--lime) 45%, transparent); }
  .map .node.code rect { stroke: color-mix(in srgb, var(--blue) 45%, transparent); }
  .map .node.law rect { stroke: color-mix(in srgb, var(--violet) 45%, transparent); }
  .map .node.skills rect { stroke: color-mix(in srgb, var(--amber) 40%, transparent); }
  .map .node.tests rect { stroke: color-mix(in srgb, var(--lime) 35%, transparent); }
  .map .node.spec rect { stroke: color-mix(in srgb, var(--blue) 30%, transparent); }
  .map .node { cursor: pointer; }
  .map .node:hover rect { stroke: var(--lime); }
  .map .node text { fill: var(--text); font-family: var(--mono); font-size: 11.5px; }
  .map .node .meta { fill: var(--dim); font-size: 10px; }
  .map .node.collapsed rect { stroke-dasharray: 4 3; }

  /* ---------- architecture: modes, graph, detail panel ---------- */
  .map-tools button.on { border-color: var(--lime); color: var(--lime); }
  .inp { font-family: var(--mono); font-size: 11.5px; padding: 5px 10px; border-radius: 7px; border: 1px solid var(--line); background: var(--panel-2); color: var(--text); min-width: 170px; }
  .inp:focus { outline: none; border-color: var(--lime); }
  .arch-body { display: grid; grid-template-columns: 1fr 300px; gap: 12px; align-items: start; }
  @media (max-width: 1100px) { .arch-body { grid-template-columns: 1fr; } }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r); padding: 14px 16px; min-height: 120px; }
  .kv { display: flex; justify-content: space-between; gap: 10px; padding: 4px 0; font-size: 12px; border-bottom: 1px solid var(--line-soft); }
  .kv:last-child { border-bottom: 0; }
  .kv span { color: var(--dim); }
  .kv b { font-family: var(--mono); font-weight: 600; }
  .map .node.dim { opacity: .25; }
  .map .node.sel rect { stroke: var(--lime); stroke-width: 2; }
  .map .gnode { cursor: pointer; }
  .map .gnode rect { fill: var(--panel-2); stroke: var(--line); }
  .map .gnode.code rect { stroke: color-mix(in srgb, var(--blue) 45%, transparent); }
  .map .gnode.law rect { stroke: color-mix(in srgb, var(--violet) 45%, transparent); }
  .map .gnode.skills rect { stroke: color-mix(in srgb, var(--amber) 40%, transparent); }
  .map .gnode.tests rect { stroke: color-mix(in srgb, var(--lime) 40%, transparent); }
  .map .gnode:hover rect, .map .gnode.sel rect { stroke: var(--lime); stroke-width: 2; }
  .map .gnode.dim { opacity: .25; }
  .map .gnode text { fill: var(--text); font-family: var(--mono); font-size: 12px; }
  .map .gnode .meta { fill: var(--dim); font-size: 10px; }
  .map .edge { fill: none; stroke: var(--dim-2); opacity: .55; }
  .map .edge.hot { stroke: var(--lime); opacity: 1; }
  .map .edge-w { fill: var(--dim-2); font-family: var(--mono); font-size: 9.5px; text-anchor: middle; }
  .row.sel { background: var(--panel-2); }
  .wave-agents { margin: 4px 0 0 27px; display: flex; gap: 6px; flex-wrap: wrap; }

  #modal { position: fixed; inset: 0; background: rgba(4,6,10,.7); display: none; align-items: center; justify-content: center; padding: 28px; z-index: 50; }
  #modal.open { display: flex; }
  #modal .box { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r); width: 100%; max-width: 1040px; max-height: 84vh; overflow: auto; padding: 16px 18px; }
  #modal h3 { font-family: var(--mono); font-size: 13px; margin-bottom: 10px; }
  #modal pre { font-family: var(--mono); font-size: 11.5px; white-space: pre-wrap; word-break: break-word; }
  .d-add { color: var(--lime); } .d-del { color: var(--red); } .d-hunk { color: var(--blue); }
  .flash { animation: flash 1.2s ease; }
  @keyframes flash { 0% { box-shadow: inset 0 0 0 1px var(--lime); } 100% { box-shadow: none; } }
  /* ---------- run view (autopilot parity) ---------- */
  .run-hero { border-radius: var(--r); padding: 20px 24px; color: #ffffff; margin-bottom: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.25); }
  .run-hero.run-working { background: #2F45E0; }
  .run-hero.run-waiting { background: #FF6B35; }
  .run-hero.run-closed { background: #17864A; }
  .run-hero.run-failed { background: #C81E1E; }
  .run-hero-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; flex-wrap: wrap; }
  .run-hero-badges { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .run-hero-badge { font-family: var(--mono); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; padding: 4px 10px; border-radius: 999px; background: rgba(255,255,255,0.22); }
  .run-wip-badge { font-family: var(--mono); font-size: 11px; font-weight: 800; letter-spacing: 0.8px; padding: 4px 10px; border-radius: 999px; background: rgba(255,255,255,0.28); color: #fff; border: 1px solid rgba(255,255,255,0.4); }
  .run-hero-title { font-size: 18px; font-weight: 700; letter-spacing: -0.3px; }
  .run-hero-sentence { font-size: 13.5px; opacity: 0.95; line-height: 1.4; margin-top: 6px; }
  .run-tokens { font-family: var(--mono); font-size: 12px; opacity: 0.9; margin-top: 6px; }
  .run-hero-question { margin-top: 14px; padding: 12px 14px; background: rgba(0, 0, 0, 0.25); border: 1px solid rgba(255, 255, 255, 0.35); border-radius: 8px; display: flex; align-items: flex-start; gap: 10px; }
  .run-question-badge { font-family: var(--mono); font-size: 13px; font-weight: 800; background: #fff; color: #FF6B35; width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex: 0 0 auto; line-height: 1; }
  .run-question-content { flex: 1; min-width: 0; }
  .run-question-label { font-family: var(--mono); font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.85; margin-bottom: 2px; }
  .run-question-text { font-size: 13px; font-weight: 600; line-height: 1.4; word-break: break-word; }
  .run-track { display: flex; align-items: center; gap: 4px; margin-bottom: 16px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r); padding: 14px 16px; overflow-x: auto; }
  .run-step { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 105px; position: relative; }
  .run-step-circle { width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-family: var(--mono); font-size: 11px; font-weight: 700; background: var(--panel-2); border: 1px solid var(--line); color: var(--dim); flex: 0 0 auto; }
  .run-step.done .run-step-circle { background: color-mix(in srgb, var(--lime) 20%, transparent); border-color: var(--lime); color: var(--lime); }
  .run-step.in_progress .run-step-circle { background: #2F45E0; border-color: #6ea8fe; color: #fff; box-shadow: 0 0 0 3px rgba(47,69,224,0.3); }
  .run-step.missed .run-step-circle { background: color-mix(in srgb, var(--red) 20%, transparent); border-color: var(--red); color: var(--red); }
  .run-step-info { display: flex; flex-direction: column; overflow: hidden; }
  .run-step-name { font-size: 12px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; }
  .run-step-status { font-family: var(--mono); font-size: 10px; color: var(--dim); }
  .run-step-arrow { color: var(--dim-2); font-size: 12px; margin-left: auto; padding-right: 4px; flex: 0 0 auto; }
  .run-tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 16px; }
  @media (max-width: 900px) { .run-tiles { grid-template-columns: 1fr; } }
  .run-tile { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r); padding: 14px 16px; }
  .run-clock-duo { display: flex; gap: 16px; align-items: baseline; }
  .run-clock-item { display: flex; flex-direction: column; }
  .run-clock-label { font-size: 10px; font-family: var(--mono); color: var(--dim-2); text-transform: uppercase; }
  .run-clock-val { font-family: var(--mono); font-size: 22px; font-weight: 700; color: var(--text); }
  .run-gates-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 16px; }
  @media (max-width: 900px) { .run-gates-grid { grid-template-columns: repeat(2, 1fr); } }
  .run-gate { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r); padding: 12px 14px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .run-gate-label { font-size: 12px; font-weight: 600; }
  .run-gate-pill { font-family: var(--mono); font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 999px; text-transform: uppercase; }
  .run-gate.pass .run-gate-pill { background: color-mix(in srgb, var(--lime) 20%, transparent); color: var(--lime); border: 1px solid color-mix(in srgb, var(--lime) 40%, transparent); }
  .run-gate.open .run-gate-pill { background: var(--panel-2); color: var(--amber); border: 1px solid color-mix(in srgb, var(--amber) 40%, transparent); }
  .run-gate.fail .run-gate-pill { background: color-mix(in srgb, var(--red) 20%, transparent); color: var(--red); border: 1px solid color-mix(in srgb, var(--red) 40%, transparent); }
  .run-waves-section { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r); padding: 16px 18px; margin-bottom: 16px; }
  .run-wave-lane { background: var(--panel-2); border: 1px solid var(--line-soft); border-radius: var(--r); padding: 14px 16px; margin-bottom: 14px; }
  .run-wave-lane:last-child { margin-bottom: 0; }
  .run-wave-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; flex-wrap: wrap; gap: 8px; }
  .run-wave-bar { height: 6px; border-radius: 3px; background: var(--line); display: flex; overflow: hidden; margin-bottom: 12px; }
  .run-wave-bar .bar-done { background: var(--lime); }
  .run-wave-bar .bar-prog { background: #8b5cf6; }
  .run-wave-bar .bar-wait { background: var(--amber); }
  .run-tasks-matrix { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
  .run-task-card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; transition: border-color .15s ease; position: relative; }
  .run-task-card:hover { border-color: var(--dim-2); }
  .run-task-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .run-task-id { font-family: var(--mono); font-size: 11px; font-weight: 700; color: var(--text); }
  .run-task-title { font-size: 12.5px; font-weight: 600; color: var(--text); line-height: 1.35; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .run-task-bottom { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: auto; padding-top: 4px; border-top: 1px solid var(--line-soft); font-size: 11px; }
  .task-state-badge { font-family: var(--mono); font-size: 9.5px; font-weight: 700; padding: 2px 7px; border-radius: 999px; text-transform: uppercase; letter-spacing: 0.3px; }
  .task-card-green { border-left: 3px solid #10b981; }
  .task-card-green .task-state-badge { background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.35); }
  .task-card-orange { border-left: 3px solid #f59e0b; }
  .task-card-orange .task-state-badge { background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.35); }
  .task-card-purple { border-left: 3px solid #8b5cf6; }
  .task-card-purple .task-state-badge { background: rgba(139, 92, 246, 0.15); color: #8b5cf6; border: 1px solid rgba(139, 92, 246, 0.35); }
  .task-card-cyan { border-left: 3px solid #06b6d4; }
  .task-card-cyan .task-state-badge { background: rgba(6, 182, 212, 0.15); color: #06b6d4; border: 1px solid rgba(6, 182, 212, 0.35); }
  .task-card-white { border-left: 3px solid #94a3b8; }
  .task-card-white .task-state-badge { background: rgba(148, 163, 184, 0.15); color: #cbd5e1; border: 1px solid rgba(148, 163, 184, 0.3); }
  .run-task-repairs { font-family: var(--mono); font-size: 10px; color: var(--dim); padding: 1px 5px; border-radius: 4px; background: var(--panel-2); }
  .run-task-repairs.has-repairs { color: #06b6d4; background: rgba(6, 182, 212, 0.15); font-weight: 700; }
  .run-zones { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 14px; }
  @media (max-width: 700px) { .run-zones { grid-template-columns: 1fr; } }
  .run-zone-card { background: var(--panel-2); border: 1px solid var(--line-soft); border-radius: var(--r); padding: 10px 12px; cursor: pointer; transition: border-color .15s; }
  .run-zone-card:hover { border-color: var(--dim); }
  .run-zone-card.zone-green { border-left: 3px solid var(--green); }
  .run-zone-card.zone-orange { border-left: 3px solid var(--amber); }
  .run-zone-card.zone-red { border-left: 3px solid var(--red); }
  .run-zone-card.active { border-color: var(--text); background: color-mix(in srgb, var(--panel-2) 90%, #fff); }
  .run-zone-header { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 4px; }
  .run-zone-name { font-size: 11.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
  .run-zone-count { font-family: var(--mono); font-size: 13px; font-weight: 800; }
  .zone-green .run-zone-count { color: var(--green); }
  .zone-orange .run-zone-count { color: var(--amber); }
  .zone-red .run-zone-count { color: var(--red); }
  .run-zone-tickets { font-size: 11px; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.3; }
  .run-words-section { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r); padding: 16px 18px; margin-bottom: 16px; }
  .run-words-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
  .run-filter-group { display: flex; gap: 6px; flex-wrap: wrap; }
  .run-filter-btn { font-family: var(--mono); font-size: 11px; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel-2); color: var(--dim); cursor: pointer; }
  .run-filter-btn:hover { color: var(--text); }
  .run-filter-btn.active { background: var(--lime); color: #0b0e14; font-weight: 700; border-color: var(--lime); }
  .run-words-list { display: flex; flex-direction: column; gap: 8px; }
  .run-req-row { display: grid; grid-template-columns: 180px 1fr; gap: 12px; align-items: baseline; padding: 10px 12px; border-radius: 6px; background: var(--panel-2); border: 1px solid var(--line-soft); font-size: 12.5px; }
  @media (max-width: 760px) { .run-req-row { grid-template-columns: 1fr; gap: 6px; } }
  .run-req-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .run-req-id { font-family: var(--mono); font-size: 11.5px; font-weight: 700; color: var(--text); }
  .run-req-badge { font-family: var(--mono); font-size: 9.5px; font-weight: 800; padding: 1px 6px; border-radius: 4px; text-transform: uppercase; }
  .req-badge-r { background: rgba(110, 168, 254, 0.18); color: #6ea8fe; border: 1px solid rgba(110, 168, 254, 0.4); }
  .req-badge-ri { background: rgba(197, 143, 255, 0.18); color: #c58fff; border: 1px solid rgba(197, 143, 255, 0.4); }
  .req-badge-g { background: rgba(184, 255, 46, 0.18); color: #b8ff2e; border: 1px solid rgba(184, 255, 46, 0.4); }
  .req-badge-a { background: rgba(255, 181, 69, 0.18); color: #ffb545; border: 1px solid rgba(255, 181, 69, 0.4); }
  .req-badge-d { background: rgba(255, 95, 86, 0.18); color: #ff5f56; border: 1px solid rgba(255, 95, 86, 0.4); }
  .run-req-status { font-family: var(--mono); font-size: 10px; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; text-align: center; }
  .run-req-status.done { background: color-mix(in srgb, var(--lime) 20%, transparent); color: var(--lime); }
  .run-req-status.open { background: color-mix(in srgb, var(--blue) 20%, transparent); color: var(--blue); }
  .run-req-status.in-spec { background: color-mix(in srgb, #8b5cf6 20%, transparent); color: #a78bfa; }
  .run-req-status.deferred { background: var(--panel); color: var(--dim-2); }
  .run-req-text { font-style: italic; color: var(--text); line-height: 1.45; word-break: break-word; }
  .run-feed-section { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r); padding: 16px 18px; }
  .run-feed-list { font-family: var(--mono); font-size: 11.5px; max-height: 280px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
  .run-feed-item { display: grid; grid-template-columns: 66px 90px 1fr; gap: 10px; padding: 6px 8px; border-radius: 4px; background: var(--panel-2); align-items: baseline; }
  .run-feed-item:last-child { border-bottom: 0; }
  .badge-offline { font-family: var(--mono); font-size: 11px; padding: 4px 10px; border-radius: 999px; background: #C81E1E; color: #fff; font-weight: 700; display: inline-flex; align-items: center; gap: 5px; }
</style>
</head>
<body>
<header>
  <div class="brand"><span>null</span><span class="x">✕</span><span>form</span><span class="sub">console</span></div>
  <span class="chip">проект <b id="h-project">…</b></span>
  <span class="chip">сессия <b id="h-session">…</b></span>
  <span class="chip">модель <b id="h-model">…</b></span>
  <span class="chip" id="h-branch">…</span>
  <div class="spacer"></div>
  <span class="badge-offline" id="offline-badge" style="display:${isFrozen ? 'inline-flex' : 'none'}"><span id="offline-text">${isFrozen ? 'OFFLINE' : ''}</span></span>
  <span class="live" id="live" style="display:${isFrozen ? 'none' : 'inline-flex'}"><span class="dot"></span><span id="live-text">снимок</span></span>
  <button class="ibtn" onclick="refreshNow()" title="Обновить">⟳</button>
  <button class="ibtn" onclick="setTheme('dark')" title="Тёмная">◐</button>
  <button class="ibtn" onclick="setTheme('light')" title="Светлая">◑</button>
  <div class="seg"><button id="l-ru" class="active" onclick="setLang('ru')">RU</button><button id="l-en" onclick="setLang('en')">EN</button></div>
</header>

<div class="shell">
  <nav class="rail" id="rail"></nav>
  <main class="content">
    <section class="tab" id="tab-run"></section>
    <section class="tab" id="tab-overview"></section>
    <section class="tab" id="tab-arch"></section>
    <section class="tab" id="tab-logs"></section>
    <section class="tab" id="tab-diffs"></section>
    <section class="tab" id="tab-critique"></section>
    <section class="tab" id="tab-debt"></section>
    <section class="tab" id="tab-history"></section>
  </main>
</div>

<div id="modal" onclick="if(event.target===this)closeModal()">
  <div class="box"><h3 id="modal-title">…</h3><pre id="modal-body">…</pre></div>
</div>

<script>
  window.NF_SNAPSHOT = ${payload};
  var DATA = window.NF_SNAPSHOT;
  var IS_FROZEN = ${isFrozen};
  var POLL_MS = ${pollMs};
  var savedTab = localStorage.getItem("nf-tab");
  var TAB = savedTab || ((DATA.run && DATA.run.open) ? "run" : "overview");
  if (!DATA.run && TAB === "run") TAB = "overview";
  var lang = localStorage.getItem("nf-lang") || "ru";
  var collapsed = null;         // свёрнутые узлы майндкарты (null = ещё не инициализировано)
  var fingerprint = null;

  /* ============================ i18n ============================ */
  var I18N = {
    ru: {
      // шапка
      project: "проект", session: "сессия", model: "модель", live: "LIVE", snapshot: "снимок",
      // вкладки
      overview: "Обзор", arch: "Архитектура", logs: "Логи сессии", diffs: "Диффы", critique: "Критика", debt: "Долг", history: "История",
      // обзор
      progress: "Прогресс проекта", coverage: "Покрытие брифа", stageNow: "Этап сейчас", elapsed: "Прошло", remaining: "Осталось",
      artifacts: "Артефакты", debtShort: "Долг", diffsShort: "Диффы", memory: "Память",
      cost: "Стоимость сессии", tokens: "Токены", sessionCard: "Сессия",
      reqs: "требований", budget: "бюджет яруса", calls: "вызовов", deferMarks: "маркеров defer:",
      noTrigger: "без триггера", daysSince: "дней с ревизии", noReview: "ревизия не проводилась",
      stagesDone: "обязательных этапов", artifactsOf: "артефактов", notRequired: "не требуется для яруса",
      taskClosed: "задача завершена", allArtifacts: "обязательные артефакты собраны", median: "медиана",
      byMedianOf: "по медиане", closedTasks: "закрытых задач", noData: "нет данных", notGit: "не git-репозиторий",
      stages: "Этапы", build: "Ход сборки — волны SDD", wave: "Волна",
      stage_lane: "Ярус и постановка", stage_recon: "Разведка и контекст", stage_manifest: "Манифест требований (R##)",
      stage_openspec: "Спецификация OpenSpec", stage_interfaces: "Интерфейсы и владельцы",
      stage_oracle: "Слепая приёмка Оракула", stage_closed: "Закрытие и архив",
      st_in_progress: "идёт", st_active: "идёт",
      st_done: "готово", st_wait: "ждёт", st_running: "идёт", st_skipped: "не требуется", st_missed: "пропущено", st_pending: "не начат",
      status_closed: "ЗАКРЫТА", status_open: "В РАБОТЕ", status_idle: "ОЖИДАНИЕ",
      mem_fresh: "В НОРМЕ", mem_overdue: "ПРОСРОЧЕНА", mem_none: "НЕТ ДАННЫХ",
      cache: "кэш", updating: "данные обновляются", byPaseo: "по данным Paseo", provider: "провайдер",
      // архитектура
      viewTree: "Схема", viewGraph: "Граф зависимостей", viewTable: "Таблица",
      collapseAll: "Свернуть всё", expandAll: "Развернуть всё", clickNode: "клик по узлу — детали",
      files: "файлов", lines: "строк", filter: "фильтр: имя модуля", zoom: "масштаб", reset: "сброс",
      details: "Детали", incoming: "Входящие", outgoing: "Исходящие", external: "Внешние импорты",
      topFiles: "Крупнейшие файлы", noDeps: "связей нет", selectNode: "Выберите узел, чтобы увидеть детали",
      kindCode: "код", kindLaw: "законы", kindSkills: "навыки", kindTests: "тесты", kindSpec: "спеки", kindOther: "прочее", kindRoot: "проект",
      depImport: "импорт", depRef: "ссылка",
      // логи
      wfEvents: "События воркфлоу", agentSession: "Сессия агента", noEvents: "Событий пока нет — они появятся после start/artifact/close",
      noTranscript: "Транскрипт сессии не найден",
      // диффы
      diffHint: "Диффы (git) — клик по файлу откроет diff", cleanTree: "Рабочее дерево чистое",
      branch: "Ветка", commit: "коммит", modified: "изменён", untracked: "новый",
      // критика
      critiqueTitle: "Критика и ревью", noVerdicts: "Вердиктов оракула пока нет",
      v_accept: "ПРИНЯТО", v_reject: "ОТКЛОНЕНО", v_mixed: "С ЗАМЕЧАНИЯМИ", v_unknown: "НЕТ ВЕРДИКТА",
      concerns: "замечаний", noChecks: "Автопроверки не запускались",
      // долг
      debtTitle: "Технический долг", debtClean: "Осознанного техдолга нет — реестр чист",
      ceiling: "потолок", upgrade: "апгрейд",
      // история
      historyTitle: "История работы", closedCount: "Закрыто задач", byTier: "по ярусам", empty: "пусто",
      howItWorks: "Как это работает", help: "Справка", close: "Закрыть",
      // run (D01)
      run: "Прогон",
      runHeroWorking: "В работе", runHeroWaiting: "Ожидание оператора", runHeroClosed: "Завершён", runHeroFailed: "Провал",
      runActiveTime: "Время работы", runWaitTime: "Время ожидания",
      runSentenceOpen: "Пройдено стадий: {s}/8 · Выполнено требований: {r}/{t} ({pct}%)",
      runSentenceClosed: "Прогон закрыт · Вердикт оракула: {v} · Техдолг: {d}",
      pendingQuestion: "Ожидание ответа:",
      waitingForUser: "Ожидание подтверждения или ввода данных",
      runFilterDeferred: "Отложено",
      runRequirements: "Требования (слова пользователя)", runGates: "Гейты качества", runFeed: "Лента событий",
      runFilterAll: "Все", runFilterDone: "Выполнены", runFilterOpen: "В работе",
      gateG1: "G1: Манифест записан", gateG2: "G2: OpenSpec валиден", gateG3: "G3: Интерфейсы записаны", gateG4: "G4: Приёмка Оракула",
      gatePass: "ПРОЙДЕН", gateOpen: "ОТКРЫТ", gateFail: "ПРОВАЛ",
      runWaves: "Волны выполнения (SDD)",
      calibrationTarget: "Калибровка ~3000 строк/тикет",
      calibMerge: "слить (<1500)",
      calibSplit: "разбить (>4500)",
      calibOk: "в норме (~3K)",
      tickets: "задач",
      linesCount: "строк",
      runTokens: "Токены",
      runZones: "Зоны статуса",
      runZoneGreen: "Зелёная",
      runZoneOrange: "Оранжевая",
      runZoneRed: "Красная",
      offline: "OFFLINE", offlineBadge: "автономный снимок", noRun: "Нет активного прогона воркфлоу",
    },
    en: {
      project: "project", session: "session", model: "model", live: "LIVE", snapshot: "snapshot",
      overview: "Overview", arch: "Architecture", logs: "Session log", diffs: "Diffs", critique: "Critique", debt: "Debt", history: "History",
      progress: "Project progress", coverage: "Brief coverage", stageNow: "Current stage", elapsed: "Elapsed", remaining: "Remaining",
      artifacts: "Artifacts", debtShort: "Debt", diffsShort: "Diffs", memory: "Memory",
      cost: "Session cost", tokens: "Tokens", sessionCard: "Session",
      reqs: "requirements", budget: "tier budget", calls: "calls", deferMarks: "defer: markers",
      noTrigger: "no trigger", daysSince: "days since review", noReview: "never reviewed",
      stagesDone: "required stages", artifactsOf: "artifacts", notRequired: "not required for tier",
      taskClosed: "task closed", allArtifacts: "all required artifacts collected", median: "median",
      byMedianOf: "median of", closedTasks: "closed tasks", noData: "no data", notGit: "not a git repo",
      stages: "Stages", build: "Build — SDD waves", wave: "Wave",
      stage_lane: "Lane & statement", stage_recon: "Recon & context", stage_manifest: "Requirements manifest (R##)",
      stage_openspec: "OpenSpec specification", stage_interfaces: "Interfaces & owners",
      stage_oracle: "Oracle blind acceptance", stage_closed: "Close & archive",
      st_in_progress: "running", st_active: "running",
      st_done: "done", st_wait: "waiting", st_running: "running", st_skipped: "not required", st_missed: "missed", st_pending: "not started",
      status_closed: "CLOSED", status_open: "IN PROGRESS", status_idle: "IDLE",
      mem_fresh: "FRESH", mem_overdue: "OVERDUE", mem_none: "NO DATA",
      cache: "cache", updating: "refreshing", byPaseo: "from Paseo", provider: "provider",
      viewTree: "Scheme", viewGraph: "Dependency graph", viewTable: "Table",
      collapseAll: "Collapse all", expandAll: "Expand all", clickNode: "click a node for details",
      files: "files", lines: "lines", filter: "filter: module name", zoom: "zoom", reset: "reset",
      details: "Details", incoming: "Incoming", outgoing: "Outgoing", external: "External imports",
      topFiles: "Largest files", noDeps: "no links", selectNode: "Select a node to see details",
      kindCode: "code", kindLaw: "law", kindSkills: "skills", kindTests: "tests", kindSpec: "specs", kindOther: "other", kindRoot: "project",
      depImport: "import", depRef: "reference",
      wfEvents: "Workflow events", agentSession: "Agent session", noEvents: "No events yet — they appear after start/artifact/close",
      noTranscript: "Session transcript not found",
      diffHint: "Git diffs — click a file to open the diff", cleanTree: "Working tree is clean",
      branch: "Branch", commit: "commit", modified: "modified", untracked: "untracked",
      critiqueTitle: "Critique & review", noVerdicts: "No oracle verdicts yet",
      v_accept: "ACCEPTED", v_reject: "REJECTED", v_mixed: "WITH CONCERNS", v_unknown: "NO VERDICT",
      concerns: "concerns", noChecks: "Automated checks were not run",
      debtTitle: "Technical debt", debtClean: "No deliberate debt — ledger is clean",
      ceiling: "ceiling", upgrade: "upgrade",
      historyTitle: "Work history", closedCount: "Closed tasks", byTier: "by tier", empty: "empty",
      howItWorks: "How it works", help: "Help", close: "Close",
      // run (D01)
      run: "Run",
      runHeroWorking: "Working", runHeroWaiting: "Waiting for input", runHeroClosed: "Closed", runHeroFailed: "Failed",
      runActiveTime: "Active time", runWaitTime: "Wait time",
      runSentenceOpen: "Stages completed: {s}/6 · Requirements completed: {r}/{t} ({pct}%)",
      runSentenceClosed: "Run closed · Oracle verdict: {v} · Tech debt: {d}",
      runRequirements: "Requirements (user words)", runGates: "Quality gates", runFeed: "Activity feed",
      runSentenceOpen: "Stages completed: {s}/8 · Requirements completed: {r}/{t} ({pct}%)",
      runSentenceClosed: "Run closed · Oracle verdict: {v} · Tech debt: {d}",
      pendingQuestion: "Pending question:",
      waitingForUser: "Waiting for user confirmation or input",
      runFilterDeferred: "Deferred",
      gatePass: "PASS", gateOpen: "OPEN", gateFail: "FAIL",
      offline: "OFFLINE", offlineBadge: "offline snapshot", noRun: "No active workflow run",
      runWaves: "Execution waves (SDD)",
      calibrationTarget: "Calibration ~3000 lines/ticket",
      calibMerge: "merge (<1500)",
      calibSplit: "split (>4500)",
      calibOk: "optimal (~3K)",
      tickets: "tickets",
      linesCount: "lines",
      runTokens: "Tokens",
      runZones: "Status zones",
      runZoneGreen: "Green",
      runZoneOrange: "Orange",
      runZoneRed: "Red",
      offline: "OFFLINE", offlineBadge: "offline snapshot", noRun: "No active workflow run",
    }
  };
  function t(k) { return (I18N[lang] && I18N[lang][k]) || (I18N.ru[k] || k); }

  function esc(s) { return String(s === null || s === undefined ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
  function fmtDur(ms) {
    if (ms === null || ms === undefined || ms < 0) return "—";
    var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h > 0 ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(sec).padStart(2, "0");
  }
  function fmtTime(iso) {
    if (!iso) return "";
    try { var d = new Date(iso); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0"); } catch (e) { return ""; }
  }
  function num(n) { return Number(n || 0).toLocaleString(lang === "ru" ? "ru-RU" : "en-US"); }
  var CLS = { done: "done", in_progress: "active", missed: "missed", skipped: "skipped", pending: "pending" };
  function scls(s) { return CLS[s] || "pending"; }
  function stime(s) { return s.durationMs ? fmtDur(s.durationMs) : t("st_" + s.status) || t("st_pending"); }
  function wtime(s) { return s.durationMs ? fmtDur(s.durationMs) : (s.status === "done" ? t("st_done") : s.status === "skipped" ? t("st_skipped") : t("st_wait")); }
  function badge(s) { return s === "closed" ? t("status_closed") : s === "open" ? t("status_open") : t("status_idle"); }
  function memLabel(s) { return s === "fresh" ? t("mem_fresh") : s === "overdue" ? t("mem_overdue") : t("mem_none"); }
  function kindLabel(k) { return t("kind" + k.charAt(0).toUpperCase() + k.slice(1)) || k; }
  /** Имя стадии переводится по её id: сервер не хранит язык интерфейса. */
  function stageName(s) { return t("stage_" + s.id) || s.id; }
  /** Заметка стадии: «не требуется для яруса T1» / «пропущено» — на языке интерфейса. */
  function stageNote(s) {
    if (s.note === "skipped") return t("notRequired") + " " + esc(s.tier || "");
    if (s.note === "missed") return t("st_missed");
    return s.detail ? esc(s.detail) : "";
  }

  /* ============================ rail ============================ */
  var TABS = [
    { id: "run", ico: "◉" },
    { id: "overview", ico: "◎" }, { id: "arch", ico: "⑃" }, { id: "logs", ico: "≡" },
    { id: "diffs", ico: "±" }, { id: "critique", ico: "✓" }, { id: "debt", ico: "⏚" }, { id: "history", ico: "⏱" },
  ];
  function renderRail(d) {
    var counts = { diffs: d.git.files.length, critique: d.critique.length, debt: d.metrics.debt.total, logs: d.log.entries.length + (d.events || []).length, history: d.history.total };
    if (d.run) counts.run = (d.run.requirements || []).length;
    var availableTabs = TABS.filter(function (x) {
      if (x.id === "run") return Boolean(d.run);
      return true;
    });
    document.getElementById("rail").innerHTML = availableTabs.map(function (x) {
      return '<button data-tab="' + x.id + '" class="' + (TAB === x.id ? "active" : "") + '" title="' + t(x.id) + '">' +
        '<span class="ico">' + x.ico + "</span><span>" + t(x.id) + "</span>" +
        (counts[x.id] ? '<span class="badge-n">' + counts[x.id] + "</span>" : "") + "</button>";
    }).join("");
    document.querySelectorAll("#rail button").forEach(function (b) {
      b.addEventListener("click", function () { showTab(b.getAttribute("data-tab")); });
    });
  }

  /* ============================ run ============================ */
  var currentRunRev = null;
  var runReqFilter = "all";
  var runZoneFilter = "all";

  function getTicketZone(tk) {
    var rep = Number(tk.repairs !== undefined ? tk.repairs : (tk.repairCount !== undefined ? tk.repairCount : 0)) || 0;
    var st = String(tk.status || "").toLowerCase();
    if (rep >= 2 || st === "failed" || st === "blocked" || st === "error") return "red";
    if (st === "done" || st === "closed" || st === "verified") return "green";
    return "orange";
  }

  function getReqType(id) {
    if (!id) return "R";
    var s = String(id).trim();
    if (/^R\d+i$/i.test(s) || (s.toLowerCase().startsWith("r") && s.toLowerCase().endsWith("i"))) return "Ri";
    if (/^G\d+/i.test(s)) return "G";
    if (/^A\d+/i.test(s)) return "A";
    if (/^D\d+/i.test(s)) return "D";
    if (/^R\d+/i.test(s)) return "R";
    return "R";
  }

  function getTaskStateColor(st) {
    var s = String(st || "").toLowerCase();
    if (s === "done" || s === "closed" || s === "verified" || s === "pass" || s === "success") return "green";
    if (s === "waiting" || s === "blocked" || s === "warning" || s === "fail" || s === "failed") return "orange";
    if (s === "in_progress" || s === "running" || s === "active") return "purple";
    if (s === "repair" || s === "retry" || s === "testing") return "cyan";
    return "white";
  }

  function getTrackStages(runData) {
    var stagesList = runData.stages || [];
    var findS = function (id) {
      return stagesList.find(function (s) { return s.id === id; });
    };

    var lane = findS("lane") || findS("preflight");
    var recon = findS("recon") || findS("briefing");
    var manifest = findS("manifest");
    var spec = findS("openspec") || findS("spec");
    var plan = findS("interfaces") || findS("plan");
    var dev = findS("dev");
    var review = findS("review");
    var oracle = findS("oracle") || findS("accept");

    var isClosed = runData.status === "closed";

    var preflightStatus = lane ? lane.status : "done";
    var manifestStatus = manifest ? manifest.status : (isClosed || (spec && spec.status === "done") ? "done" : "pending");
    var briefingStatus = recon ? recon.status : (isClosed || (spec && (spec.status === "done" || spec.status === "in_progress")) ? "done" : "pending");
    var specStatus = spec ? spec.status : (isClosed || (plan && (plan.status === "done" || plan.status === "in_progress")) ? "done" : "pending");
    var planStatus = plan ? plan.status : (isClosed ? "done" : "pending");

    var devStatus = "pending";
    if (dev) {
      devStatus = dev.status;
    } else if (isClosed) {
      devStatus = "done";
    } else if (runData.waves && runData.waves.length > 0) {
      var allTickets = [];
      runData.waves.forEach(function (w) { (w.tickets || []).forEach(function (tk) { allTickets.push(tk); }); });
      var anyActive = allTickets.some(function (tk) { return tk.status === "in_progress" || tk.status === "running" || tk.status === "active"; });
      var allDone = allTickets.length > 0 && allTickets.every(function (tk) { return tk.status === "done" || tk.status === "closed" || tk.status === "verified"; });
      if (allDone) devStatus = "done";
      else if (anyActive) devStatus = "in_progress";
      else if (planStatus === "done") devStatus = "in_progress";
    } else if (planStatus === "done" && (!oracle || oracle.status !== "done")) {
      devStatus = "in_progress";
    }

    var reviewStatus = "pending";
    if (review) {
      reviewStatus = review.status;
    } else if (isClosed) {
      reviewStatus = "done";
    } else if (oracle && (oracle.status === "done" || oracle.status === "in_progress")) {
      reviewStatus = "done";
    } else if (devStatus === "done") {
      reviewStatus = "in_progress";
    }

    var acceptStatus = "pending";
    if (oracle) {
      acceptStatus = oracle.status;
    } else if (isClosed) {
      acceptStatus = "done";
    } else if (reviewStatus === "done") {
      acceptStatus = "in_progress";
    }

    return [
      { id: "preflight", name: "Preflight", status: preflightStatus },
      { id: "manifest", name: "Manifest", status: manifestStatus },
      { id: "briefing", name: "Briefing", status: briefingStatus },
      { id: "spec", name: "Spec", status: specStatus },
      { id: "plan", name: "Plan", status: planStatus },
      { id: "dev", name: "Dev", status: devStatus },
      { id: "review", name: "Review", status: reviewStatus },
      { id: "accept", name: "Accept", status: acceptStatus },
    ];
  }

  function tickRun() {
    if (IS_FROZEN || !DATA || !DATA.run || DATA.run.status === "closed") return;
    if (DATA.run.status === "waiting") {
      DATA.run.waitMs = (DATA.run.waitMs || 0) + 1000;
    } else {
      DATA.run.activeMs = (DATA.run.activeMs || 0) + 1000;
    }
    var elActive = document.getElementById("run-clock-active");
    if (elActive) elActive.textContent = fmtDur(DATA.run.activeMs);
    var elWait = document.getElementById("run-clock-wait");
    if (elWait) elWait.textContent = fmtDur(DATA.run.waitMs);
  }

  function setRunFilter(flt) {
    if (flt === "green" || flt === "orange" || flt === "red") {
      runZoneFilter = (runZoneFilter === flt) ? "all" : flt;
    } else if (flt === "all-zones") {
      runZoneFilter = "all";
    } else {
      runReqFilter = flt;
    }
    currentRunRev = null;
    if (DATA && DATA.run) renderRun(DATA);
  }

  function renderRun(d) {
    var host = document.getElementById("tab-run");
    if (!host) return;
    if (!d || !d.run) {
      host.innerHTML = '<div class="empty">' + esc(t("noRun")) + "</div>";
      return;
    }
    var r = d.run;
    if (currentRunRev && currentRunRev === r.rev) {
      var elA = document.getElementById("run-clock-active");
      if (elA) elA.textContent = fmtDur(r.activeMs);
      var elW = document.getElementById("run-clock-wait");
      if (elW) elW.textContent = fmtDur(r.waitMs);
      return;
    }
    currentRunRev = r.rev;

    var heroCls = "run-working";
    if (r.status === "closed") heroCls = "run-closed";
    else if (r.status === "failed") heroCls = "run-failed";
    else if (r.status === "waiting") heroCls = "run-waiting";

    var heroBadgeText = r.status === "closed" ? t("runHeroClosed") : (r.status === "failed" ? t("runHeroFailed") : (r.status === "waiting" ? t("runHeroWaiting") : t("runHeroWorking")));
    var wipBadgeHtml = r.status !== "closed" ? '<span class="run-hero-badge run-wip-badge">WIP</span>' : '';

    var trackList = getTrackStages(r);
    var doneStages = trackList.filter(function (s) { return s.status === "done"; }).length;
    var totalReqs = (r.requirements || []).length;
    var doneReqs = (r.requirements || []).filter(function (req) { return req.status === "done" || req.status === "verified" || req.status === "closed"; }).length;
    var reqPct = totalReqs > 0 ? Math.round((doneReqs / totalReqs) * 100) : (r.status === "closed" ? 100 : 0);

    var sentence = "";
    if (r.status === "closed") {
      var oracleVerdict = (r.gates && r.gates.G4 && r.gates.G4.ok) ? "ACCEPT" : (r.gates && r.gates.G4 && r.gates.G4.ok === false ? "REJECT" : "—");
      var debtCount = d.metrics && d.metrics.debt ? d.metrics.debt.total : 0;
      sentence = t("runSentenceClosed").replace("{v}", oracleVerdict).replace("{d}", debtCount);
    } else {
      sentence = t("runSentenceOpen").replace("{s}", doneStages).replace("{r}", doneReqs).replace("{t}", totalReqs).replace("{pct}", reqPct);
    }

    var questionHtml = "";
    if (r.status === "waiting") {
      var qText = r.pendingQuestion || r.question || (r.waiting && r.waiting.question) || (r.waits && r.waits.length ? r.waits[r.waits.length - 1].kind : "") || t("waitingForUser");
      questionHtml = '<div class="run-hero-question">' +
        '<span class="run-question-badge">?</span>' +
        '<div class="run-question-content">' +
          '<div class="run-question-label">' + esc(t("pendingQuestion")) + '</div>' +
          '<div class="run-question-text">' + esc(qText) + '</div>' +
        '</div>' +
      '</div>';
    }

    var tok = r.tokens || (d.session && d.session.usage ? {
      input: d.session.usage.inputTokens,
      output: d.session.usage.outputTokens,
      cached: d.session.usage.cachedTokens,
      costUsd: d.session.usage.costUsd,
    } : null);
    var tokensText = "—";
    if (tok && (tok.input > 0 || tok.output > 0 || tok.cached > 0 || tok.costUsd !== null)) {
      var cPct = (tok.input + tok.cached > 0) ? Math.round((tok.cached / (tok.input + tok.cached)) * 100) : 0;
      var costStr = tok.costUsd !== null ? ("$" + tok.costUsd) : "—";
      tokensText = num(tok.input) + " / " + num(tok.output) + " (" + esc(t("cache")) + " " + cPct + "%) · " + costStr;
    }
    var tokensHtml = '<div class="run-tokens">' + tokensText + '</div>';

    var heroHtml = '<div class="run-hero ' + heroCls + '">' +
      '<div class="run-hero-top">' +
        '<div class="run-hero-badges">' +
          '<span class="run-hero-badge">' + esc(heroBadgeText) + '</span>' +
          wipBadgeHtml +
        '</div>' +
        '<span class="chip" style="background:rgba(255,255,255,0.2);color:#fff;border-color:transparent">' + esc(r.tier || "T1") + '</span>' +
      '</div>' +
      '<div class="run-hero-title">' + esc(r.task || ("Задача " + (r.tier || "T1"))) + '</div>' +
      '<div class="run-hero-sentence">' + esc(sentence) + '</div>' +
      tokensHtml +
      questionHtml +
    '</div>';

    var trackSteps = trackList.map(function (stObj, idx) {
      var sclsName = scls(stObj.status);
      var isLast = idx === trackList.length - 1;
      var circleText = stObj.status === "done" ? "✓" : String(idx + 1);
      return '<div class="run-step ' + sclsName + '">' +
        '<div class="run-step-circle">' + circleText + '</div>' +
        '<div class="run-step-info">' +
          '<div class="run-step-name">' + esc(stObj.name) + '</div>' +
          '<div class="run-step-status">' + esc(t("st_" + stObj.status) || stObj.status) + '</div>' +
        '</div>' +
        (!isLast ? '<span class="run-step-arrow">→</span>' : '') +
      '</div>';
    }).join("");
    var trackHtml = '<div class="run-track">' + trackSteps + '</div>';

    var gatesObj = r.gates || {};
    var passGatesCount = 0;
    ["G1", "G2", "G3", "G4"].forEach(function (gk) { if (gatesObj[gk] && gatesObj[gk].ok) passGatesCount++; });

    var beatsInfo = (r.beats && r.beats.length) ? (r.beats.length + " beats (≤45m)") : "beats ≤45m без пауз";
    var tilesHtml = '<div class="run-tiles">' +
      '<div class="run-tile">' +
        '<div class="label">' + esc(t("runRequirements")) + '</div>' +
        '<div class="v">' + doneReqs + ' / ' + totalReqs + '</div>' +
        '<div class="bar mini"><i style="width:' + reqPct + '%"></i></div>' +
        '<div class="note">' + reqPct + '% ' + esc(t("coverage")) + '</div>' +
      '</div>' +
      '<div class="run-tile">' +
        '<div class="label">' + esc(t("runGates")) + '</div>' +
        '<div class="v">' + passGatesCount + ' / 4</div>' +
        '<div class="bar mini"><i style="width:' + Math.round((passGatesCount / 4) * 100) + '%"></i></div>' +
        '<div class="note">G1–G4 ' + esc(t("gatePass")) + '</div>' +
      '</div>' +
      '<div class="run-tile">' +
        '<div class="label">' + esc(t("timing")) + '</div>' +
        '<div class="run-clock-duo">' +
          '<div class="run-clock-item">' +
            '<span class="run-clock-label">' + esc(t("runActiveTime")) + '</span>' +
            '<span class="run-clock-val" id="run-clock-active">' + fmtDur(r.activeMs) + '</span>' +
          '</div>' +
          '<div class="run-clock-item">' +
            '<span class="run-clock-label">' + esc(t("runWaitTime")) + '</span>' +
            '<span class="run-clock-val" id="run-clock-wait" style="color:var(--amber)">' + fmtDur(r.waitMs) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="note">' + esc(t("elapsed")) + ': ' + fmtDur((r.activeMs || 0) + (r.waitMs || 0)) + ' · ' + esc(beatsInfo) + '</div>' +
      '</div>' +
    '</div>';

    var gateKeys = ["G1", "G2", "G3", "G4"];
    var gatesHtml = '<div class="run-gates-grid">' + gateKeys.map(function (gk) {
      var g = gatesObj[gk] || { ok: null, status: "open", label: gk };
      var gCls = g.ok === true ? "pass" : (g.ok === false ? "fail" : "open");
      var gText = g.ok === true ? t("gatePass") : (g.ok === false ? t("gateFail") : t("gateOpen"));
      var gLabel = t("gate" + gk) || g.label || gk;
      return '<div class="run-gate ' + gCls + '">' +
        '<span class="run-gate-label">' + esc(gLabel) + '</span>' +
        '<span class="run-gate-pill">' + esc(gText) + '</span>' +
      '</div>';
    }).join("") + '</div>';


    var wavesList = r.waves || [];
    var allTickets = [];
    wavesList.forEach(function (w) { (w.tickets || []).forEach(function (tk) { allTickets.push(tk); }); });

    var zonesData = r.zones || {
      green: { count: 0, tickets: [] },
      orange: { count: 0, tickets: [] },
      red: { count: 0, tickets: [] },
    };
    if (!r.zones) {
      allTickets.forEach(function (tk) {
        var z = getTicketZone(tk);
        zonesData[z].count++;
        zonesData[z].tickets.push(tk.id);
      });
    }

    var zoneKeys = ["green", "orange", "red"];
    var zoneCardsHtml = zoneKeys.map(function (zk) {
      var zObj = zonesData[zk] || { count: 0, tickets: [] };
      var zTickets = allTickets.filter(function (tk) { return getTicketZone(tk) === zk; });
      var zTitles = zTickets.map(function (tk) { return tk.title || tk.id; }).join(", ");
      var zLabel = t("runZone" + zk.charAt(0).toUpperCase() + zk.slice(1)) || zk;
      var activeCls = runZoneFilter === zk ? " active" : "";
      return '<div class="run-zone-card zone-' + zk + activeCls + '" data-zone="' + zk + '">' +
        '<div class="run-zone-header">' +
          '<span class="run-zone-name">' + esc(zLabel) + '</span>' +
          '<span class="run-zone-count">' + (zObj.count || 0) + '</span>' +
        '</div>' +
        '<div class="run-zone-tickets" title="' + esc(zTitles || "—") + '">' + esc(zTitles || "—") + '</div>' +
      '</div>';
    }).join("");
    var zonesHtml = '<div class="run-zones">' + zoneCardsHtml + '</div>';

    var wavesHtml = "";
    if (wavesList.length > 0) {
      var lanesHtml = wavesList.map(function (w) {
        var tList = w.tickets || [];
        var doneCount = tList.filter(function (tk) { return tk.status === "done" || tk.status === "closed" || tk.status === "verified"; }).length;
        var inProgCount = tList.filter(function (tk) { return tk.status === "in_progress" || tk.status === "running" || tk.status === "active"; }).length;
        var pendingCount = Math.max(0, tList.length - doneCount - inProgCount);
        var donePct = tList.length ? Math.round((doneCount / tList.length) * 100) : 0;
        var inProgPct = tList.length ? Math.round((inProgCount / tList.length) * 100) : 0;
        var pendingPct = Math.max(0, 100 - donePct - inProgPct);
        var waveLines = tList.reduce(function (sum, tk) { return sum + (Number(tk.lines) || 0); }, 0);

        var visibleTickets = tList.filter(function (tk) {
          return runZoneFilter === "all" || getTicketZone(tk) === runZoneFilter;
        });

        var taskCards = visibleTickets.length > 0 ? visibleTickets.map(function (tk) {
          var tLines = Number(tk.lines) || 0;
          var color = getTaskStateColor(tk.status);
          var repCount = Number(tk.repairs !== undefined ? tk.repairs : (tk.repairCount !== undefined ? tk.repairCount : (color === "cyan" ? 1 : 0))) || 0;

          var tHint = tLines < 1500 ? "merge" : (tLines > 4500 ? "split" : "ok");
          var hintBadge = "";
          if (tHint === "merge") {
            hintBadge = '<span class="pill" style="color:var(--amber);border-color:color-mix(in srgb, var(--amber) 40%, transparent)">' + esc(t("calibMerge")) + '</span>';
          } else if (tHint === "split") {
            hintBadge = '<span class="pill" style="color:var(--red);border-color:color-mix(in srgb, var(--red) 40%, transparent)">' + esc(t("calibSplit")) + '</span>';
          } else if (tLines > 0) {
            hintBadge = '<span class="pill" style="color:var(--dim)">' + esc(t("calibOk")) + '</span>';
          }

          return '<div class="run-task-card task-card-' + color + '">' +
            '<div class="run-task-top">' +
              '<span class="run-task-id">' + esc(tk.id) + '</span>' +
              '<span class="task-state-badge">' + esc(tk.status) + '</span>' +
            '</div>' +
            '<div class="run-task-title">' + esc(tk.title || tk.id) + '</div>' +
            '<div class="run-task-bottom">' +
              '<span class="run-task-repairs ' + (repCount > 0 ? 'has-repairs' : '') + '">' + repCount + '/2 repairs</span>' +
              '<div style="display:flex;align-items:center;gap:6px">' +
                (tLines ? '<span class="mono" style="font-size:10.5px;color:var(--dim)">' + tLines + ' ' + esc(t("linesCount")) + '</span>' : '') +
                hintBadge +
              '</div>' +
            '</div>' +
          '</div>';
        }).join("") : '<span class="mono" style="font-size:11px;color:var(--dim)">' + esc(t("empty")) + '</span>';

        return '<div class="run-wave-lane">' +
          '<div class="run-wave-header">' +
            '<div style="display:flex;align-items:center;gap:8px">' +
              '<span class="mono" style="font-weight:700;font-size:12.5px">' + esc(t("wave")) + " " + w.n + ' (Lane)</span>' +
              '<span class="pill">' + tList.length + ' ' + esc(t("tickets")) + '</span>' +
            '</div>' +
            '<span class="mono" style="font-size:11px;color:var(--dim)">' + waveLines + ' ' + esc(t("linesCount")) + '</span>' +
          '</div>' +
          '<div class="run-wave-bar">' +
            '<div class="bar-done" style="width:' + donePct + '%"></div>' +
            '<div class="bar-prog" style="width:' + inProgPct + '%"></div>' +
            '<div class="bar-wait" style="width:' + pendingPct + '%"></div>' +
          '</div>' +
          '<div class="run-tasks-matrix">' + taskCards + '</div>' +
        '</div>';
      }).join("");

      wavesHtml = '<div class="run-waves-section">' +
        '<div class="run-words-header">' +
          '<div class="label" style="margin-bottom:0">' + esc(t("runWaves")) + ' (' + wavesList.length + ')' + '</div>' +
          '<span class="mono" style="font-size:11px;color:var(--dim)">' + esc(t("calibrationTarget")) + '</span>' +
        '</div>' +
        zonesHtml +
        '<div class="run-waves-list">' + lanesHtml + '</div>' +
      '</div>';
    } else {
      wavesHtml = '<div class="run-waves-section">' +
        '<div class="label">' + esc(t("runWaves")) + '</div>' +
        zonesHtml +
        '<div class="empty">' + esc(t("noData")) + '</div>' +
      '</div>';
    }

    var filteredReqs = (r.requirements || []).filter(function (req) {
      var s = String(req.status || "").toLowerCase();
      if (runReqFilter === "all") return true;
      if (runReqFilter === "done") return s === "done" || s === "verified" || s === "closed";
      if (runReqFilter === "open") return s === "open";
      if (runReqFilter === "in-spec") return s === "in-spec" || s === "inspec";
      if (runReqFilter === "deferred") return s === "deferred" || s === "dropped" || s === "placeholder";
      return true;
    });

    var reqRows = filteredReqs.length ? filteredReqs.map(function (req) {
      var type = getReqType(req.id);
      var s = String(req.status || "").toLowerCase();
      var stCls = (s === "done" || s === "verified" || s === "closed") ? "done" : ((s === "in-spec" || s === "inspec") ? "in-spec" : ((s === "deferred" || s === "dropped") ? "deferred" : "open"));
      var stLabel = s === "done" ? t("st_done") : (s === "in-spec" ? "in-spec" : (s === "deferred" ? t("st_skipped") : t("st_in_progress")));

      return '<div class="run-req-row">' +
        '<div class="run-req-meta">' +
          '<span class="run-req-badge req-badge-' + type.toLowerCase() + '">' + esc(type) + '</span>' +
          '<span class="run-req-id">' + esc(req.id) + '</span>' +
          '<span class="run-req-status ' + stCls + '">' + esc(stLabel) + '</span>' +
        '</div>' +
        '<span class="run-req-text">“' + esc(req.text) + '”</span>' +
      '</div>';
    }).join("") : '<div class="empty">' + esc(t("noData")) + '</div>';

    var wordsHtml = '<div class="run-words-section">' +
      '<div class="run-words-header">' +
        '<div class="label" style="margin-bottom:0">' + esc(t("runRequirements")) + ' (' + (r.requirements || []).length + ')</div>' +
        '<div class="run-filter-group">' +
          '<button class="run-filter-btn ' + (runReqFilter === "all" ? "active" : "") + '" data-filter="all">' + esc(t("runFilterAll")) + '</button>' +
          '<button class="run-filter-btn ' + (runReqFilter === "done" ? "active" : "") + '" data-filter="done">' + esc(t("runFilterDone")) + '</button>' +
          '<button class="run-filter-btn ' + (runReqFilter === "open" ? "active" : "") + '" data-filter="open">' + esc(t("runFilterOpen")) + '</button>' +
          '<button class="run-filter-btn ' + (runReqFilter === "in-spec" ? "active" : "") + '" data-filter="in-spec">In-Spec</button>' +
          '<button class="run-filter-btn ' + (runReqFilter === "deferred" ? "active" : "") + '" data-filter="deferred">' + esc(t("runFilterDeferred")) + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="run-words-list">' + reqRows + '</div>' +
    '</div>';

    var feedItems = (r.feed || []).slice(-50).reverse();
    var feedRows = feedItems.length ? feedItems.map(function (item) {
      return '<div class="run-feed-item">' +
        '<span class="mono" style="color:var(--dim-2)">' + esc(fmtTime(item.t)) + '</span>' +
        '<span class="pill" style="text-align:center">' + esc(item.kind) + '</span>' +
        '<span class="grow" style="color:var(--text)">' + esc(item.text) + '</span>' +
      '</div>';
    }).join("") : '<div class="empty">' + esc(t("noEvents")) + '</div>';

    var feedHtml = '<div class="run-feed-section">' +
      '<div class="label">' + esc(t("runFeed")) + ' (' + feedItems.length + ')</div>' +
      '<div class="run-feed-list">' + feedRows + '</div>' +
    '</div>';

    host.innerHTML = heroHtml + trackHtml + tilesHtml + gatesHtml + wavesHtml + wordsHtml + feedHtml;
    host.querySelectorAll(".run-filter-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        setRunFilter(btn.getAttribute("data-filter"));
      });
    });
    host.querySelectorAll(".run-zone-card").forEach(function (card) {
      card.addEventListener("click", function () {
        setRunFilter(card.getAttribute("data-zone"));
      });
    });
  }

  function showTab(id) {
    TAB = id; localStorage.setItem("nf-tab", id);
    document.querySelectorAll(".tab").forEach(function (s) { s.classList.toggle("active", s.id === "tab-" + id); });
    document.querySelectorAll("#rail button").forEach(function (b) { b.classList.toggle("active", b.getAttribute("data-tab") === id); });
    if (id === "arch") drawArch();
  }

  /* ========================== overview ========================== */
  function card(label, value, note, id, barPct) {
    return '<div class="card"><div class="label">' + esc(label) + '</div><div class="v' + (String(value).length > 9 ? " sm" : "") + '"' + (id ? ' id="' + id + '"' : "") + ">" + value + "</div>" +
      (barPct !== undefined && barPct !== null ? '<div class="bar mini"><i style="width:' + barPct + '%"></i></div>' : "") +
      '<div class="note">' + note + "</div></div>";
  }
  function renderOverview(d) {
    var p = d.progress, m = d.metrics, g = d.git;
    var sess = "";
    if (d.session.usage) {
      var u = d.session.usage;
      var cachePct = u.inputTokens + u.cachedTokens > 0 ? Math.round(u.cachedTokens / (u.inputTokens + u.cachedTokens) * 100) : 0;
      var sessionTitle = d.session.name || (u && u.name) || d.session.key;
      var sessionSub = esc(d.session.key) + (u.status ? " · " + esc(u.status) : "") + (u.stale ? " · " + t("updating") : "");
      sess = '<div class="grid4" style="margin-bottom:14px">' +
        card(t("sessionCard"), esc(sessionTitle), sessionSub) +
        card(t("cost"), u.costUsd !== null ? "$" + u.costUsd : "—", t("byPaseo")) +
        card(t("tokens"), num(u.inputTokens) + " / " + num(u.outputTokens), t("cache") + " " + cachePct + "%") +
        card(t("model"), esc((u.model || "—").split("/").pop()), t("provider") + ": " + esc(u.provider || "—")) +
        "</div>";
    }
    var cards = [
      card(t("coverage"), m.briefCoverage + "%", m.requirements.items.length + " " + t("reqs") + (m.requirements.change ? " · " + esc(m.requirements.change) : "")),
      card(t("stageNow"), esc(d.currentStage.id ? t("stage_" + d.currentStage.id) : d.currentStage.name), d.task.status === "closed" ? t("taskClosed") : t("wave") + " " + d.currentStage.wave + " · " + p.stagesDone + "/" + p.stagesRequired),
      card(t("elapsed"), fmtDur(d.timing.elapsedMs), t("median") + " — " + (d.timing.medianTaskMs ? fmtDur(d.timing.medianTaskMs) : t("noData")), "elapsed"),
      card(t("remaining"), d.timing.remainingMin === null ? "—" : d.timing.remainingMin + "…" + d.timing.remainingMax + "m", d.timing.remainingMin === null ? (d.task.status === "closed" ? t("taskClosed") : t("allArtifacts")) : t("byMedianOf") + " " + d.history.total + " " + t("closedTasks")),
      card(t("artifacts"), p.artifactsDone + " / " + p.artifactsTotal, t("budget") + ": " + d.task.budget + " " + t("calls"), null, Math.round(p.artifactsDone / Math.max(1, p.artifactsTotal) * 100)),
      card(t("debtShort"), String(m.debt.total), t("deferMarks") + (m.debt.noTrigger ? " · " + t("noTrigger") + " " + m.debt.noTrigger : "")),
      card(t("diffsShort"), String(g.isRepo ? g.files.length : "—"), g.isRepo ? '<span class="add">+' + g.added + '</span> <span class="del">−' + g.deleted + "</span>" : t("notGit")),
      card(t("memory"), memLabel(m.memory.status), m.memory.daysSince !== null ? t("daysSince") + ": " + m.memory.daysSince : t("noReview")),
    ];
    var stages = d.stages.map(function (s) {
      var note = stageNote(s);
      return '<div class="stage ' + scls(s.status) + '"><span class="dot"></span><span class="nm">' + esc(stageName(s)) +
        (note ? ' <span class="stage-note">' + note + "</span>" : "") + '</span><span class="tm">' + stime(s) + "</span></div>";
    }).join("");
    var waves = d.waves.filter(function (w) { return w.stages.length; }).map(function (w) {
      var rows = w.stages.map(function (s) {
        var i = d.stages.findIndex(function (x) { return x.id === s.id; });
        var c = scls(s.status);
        return '<div class="task"><span class="idx">' + String(i + 1).padStart(2, "0") + '</span><span class="b ' + c + '">' + esc(stageName(s)) + '</span><span class="t">' + wtime(s) + "</span></div>";
      }).join("");
      var agents = w.agents.length ? '<div class="wave-agents">' + w.agents.map(function (a) { return '<span class="chip">' + esc(a.role) + "</span>"; }).join(" ") + "</div>" : "";
      return '<div class="wave-title">' + t("wave") + " " + w.wave + "</div>" + rows + agents;
    }).join("");

    document.getElementById("tab-overview").innerHTML =
      '<div class="title-row"><h1>' + esc(d.task.title) + "</h1>" +
      '<span class="tag ' + (d.task.status === "open" ? "on" : "") + '">' + badge(d.task.status) + "</span>" +
      '<span class="tag">4-Wave SDD</span><span class="tag warn">' + esc(d.task.tier) + "</span></div>" +
      '<div class="card" style="margin-bottom:14px"><div class="hero"><div><div class="label">' + t("progress") + "</div>" +
      '<div class="note">' + p.stagesDone + "/" + p.stagesRequired + " " + t("stagesDone") + " · " + p.artifactsDone + "/" + p.artifactsTotal + " " + t("artifactsOf") +
      (p.stagesSkipped ? " · " + p.stagesSkipped + " " + t("notRequired") + " " + esc(d.task.tier) : "") + "</div></div>" +
      '<div class="pct" id="pct">' + p.percent + "%</div></div>" +
      '<div class="bar"><i id="pbar" style="width:' + p.percent + '%"></i></div></div>' +
      sess + '<div class="grid4">' + cards.join("") + "</div>" +
      '<div class="two"><div class="card"><div class="label">' + t("stages") + "</div>" + stages + "</div>" +
      '<div class="card"><div class="label">' + t("build") + "</div>" + waves + "</div></div>";
  }

  /* ===================== architecture: 3 modes ===================== */
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
  function drawArch() { if (TAB === "arch") renderArch(); }

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
  }

  /* -------------------------------- logs ------------------------------ */
  function renderLogs(d) {
    var ev = (d.events || []).map(function (e) {
      var desc = e.status || e.text || "";
      return '<div class="ln"><span class="ts">' + esc(fmtTime(e.at)) + '</span><span class="k">' + esc(e.kind || "event") +
        '</span><span class="tx">' + esc(desc) + "</span></div>";
    }).join("");
    var sess = (d.log && d.log.entries || []).map(function (e) {
      var isErr = e.kind === "error";
      var desc = e.status || e.text || "";
      return '<div class="ln"><span class="ts">' + esc(fmtTime(e.at)) + '</span><span class="k ' + esc(e.kind) + '">' + esc(e.label || "") +
        '</span><span class="tx' + (isErr ? " err" : "") + '">' + esc(desc) + "</span></div>";
    }).join("");

    var sessTitle = d.log && d.log.file ? "Сессия агента · " + esc(d.log.file) : "Сессия агента";
    document.getElementById("tab-logs").innerHTML =
      '<div class="two"><div class="card"><div class="label">События воркфлоу (.workflow/events.jsonl)</div><div class="log">' +
      (ev || '<div class="empty">Событий пока нет — они появятся после start/artifact/close</div>') + "</div></div>" +
      '<div class="card"><div class="label">' + sessTitle + '</div><div class="log">' +
      (sess || '<div class="empty">Транскрипт сессии не найден</div>') + "</div></div></div>";
  }

  /* ------------------------------- diffs ------------------------------ */
  function renderDiffs(d) {
    var g = d.git;
    var body = !g.isRepo ? '<div class="empty">Не git-репозиторий</div>'
      : !g.files.length ? '<div class="empty">Рабочее дерево чистое</div>'
      : g.files.map(function (f) {
          return '<div class="row" data-file="' + esc(f.path) + '" style="cursor:pointer"><span class="mono grow">' + esc(f.path) + "</span>" +
            '<span class="mono"><span class="add">+' + f.added + '</span> <span class="del">−' + f.deleted + "</span></span>" +
            '<span class="pill ' + (f.status === "untracked" ? "warn" : "") + '">' + esc(f.status) + "</span></div>";
        }).join("");
    document.getElementById("tab-diffs").innerHTML = '<div class="card"><div class="label">Диффы (git) — клик по файлу откроет diff</div>' + body +
      (g.isRepo ? '<div class="note" style="margin-top:10px">Ветка <span class="mono">' + esc(g.branch) + '</span> · коммит <span class="mono">' + esc(g.commit && g.commit.hash) + "</span> " + esc(g.commit && g.commit.when) + "</div>" : "") + "</div>";
    document.querySelectorAll("#tab-diffs .row").forEach(function (r) {
      r.addEventListener("click", function () { openDiff(r.getAttribute("data-file")); });
    });
  }

  /* ------------------------------ critique ---------------------------- */
  function renderCritique(d) {
    var rows = !d.critique.length ? '<div class="empty">Вердиктов оракула пока нет</div>'
      : d.critique.map(function (c) {
          var cls = c.verdict === "accept" ? "ok" : c.verdict === "reject" ? "bad" : "warn";
          var lbl = c.verdict === "accept" ? "ПРИНЯТО" : c.verdict === "reject" ? "ОТКЛОНЕНО" : c.verdict === "mixed" ? "С ЗАМЕЧАНИЯМИ" : "НЕТ ВЕРДИКТА";
          return '<div class="row"><span class="grow"><b>' + esc(c.change) + '</b> <span class="mono" style="color:var(--dim)">' + esc(c.file) + "</span></span>" +
            '<span class="pill ' + cls + '">' + lbl + '</span><span class="note">замечаний: ' + c.concerns + "</span></div>";
        }).join("");
    var ar = d.metrics.checks && d.metrics.checks.autoReview;
    var line = ar ? '<div class="note" style="margin-top:10px">auto-review: ' + (ar.error ? esc(ar.error) : (ar.status === "unverified" ? "не подтверждено" : (ar.ok ? "пройдено, проблем " + (ar.total || 0) : "провалено, проблем " + (ar.total || 0)))) + "</div>"
      : '<div class="note" style="margin-top:10px">Автопроверки не запускались — <span class="mono">dashboard.mjs --checks</span></div>';
    document.getElementById("tab-critique").innerHTML = '<div class="card"><div class="label">Критика и ревью</div>' + rows + line + "</div>";
  }

  /* -------------------------------- debt ------------------------------ */
  function renderDebt(d) {
    var items = d.metrics.debt.items || [];
    var rows = !items.length ? '<div class="empty">Осознанного техдолга нет — реестр чист</div>'
      : items.map(function (x) {
          return '<div class="row"><span class="mono" style="color:var(--dim)">' + esc(x.file) + (x.line ? ":" + x.line : "") + '</span><span class="grow">' + esc(x.what) + "</span>" +
            '<span class="note">потолок: ' + esc(x.ceiling || "—") + (x.upgrade ? " · апгрейд: " + esc(x.upgrade) : "") + "</span></div>";
        }).join("");
    document.getElementById("tab-debt").innerHTML = '<div class="card"><div class="label">Технический долг (' + d.metrics.debt.total + ")</div>" + rows + "</div>";
  }

  /* ------------------------------ history ----------------------------- */
  function renderHistory(d) {
    var tiers = Object.keys(d.history.byTier).map(function (k) { return '<span class="chip">' + esc(k) + ": " + d.history.byTier[k] + "</span>"; }).join(" ");
    var rows = d.history.recent.length ? d.history.recent.map(function (h) {
      return '<div class="row"><span class="pill">' + esc(h.tier) + '</span><span class="grow">' + esc(h.task) + '</span><span class="mono" style="color:var(--dim)">' + fmtDur(h.durationMs) + (h.forced ? " · force" : "") + "</span></div>";
    }).join("") : '<div class="empty">История пуста</div>';
    document.getElementById("tab-history").innerHTML =
      '<div class="card"><div class="label">История работы</div>' +
      '<div class="note" style="margin-bottom:8px">Закрыто задач: <b>' + d.history.total + "</b> · медиана: <b>" + (d.history.medianMs ? fmtDur(d.history.medianMs) : "—") + "</b> · " + tiers + "</div>" +
      rows + "</div>" +
      '<div class="card" style="margin-top:14px"><div class="label">Как это работает</div>' +
      '<div class="note" style="line-height:1.9">' +
      "<b>Ярусы:</b> T0 — 1–2 файла · T1 — 3+ файла и рекогносцировка · T2 — полный 4-Wave SDD со слепой приёмкой · T3 — программа из T2-срезов<br>" +
      "<b>Коридор:</b> гейт артефактов → TDD → test-lens → мутационное тестирование → BDD Gherkin → слепая приёмка Оракула<br>" +
      "<b>Наблюдаемость:</b> дашборд привязан к сессии, обновляется каждые 3 с, показывает события воркфлоу и хвост транскрипта агента</div></div>";
  }

  /* ------------------------------- shell ------------------------------ */
  function renderHeader(d) {
    document.getElementById("h-project").textContent = d.project.name;
    var s = d.session;
    var sessionTitle = s.name || (s.usage && s.usage.name) || s.key;
    var chip = sessionTitle;
    if (s.usage) {
      var st = s.usage.status === "running" ? "● running" : "○ " + (s.usage.status || "idle");
      var cost = s.usage.costUsd !== null ? " · $" + s.usage.costUsd : "";
      chip = sessionTitle + " · " + st + cost;
    }
    document.getElementById("h-session").textContent = chip;
    document.getElementById("h-session").title = "ID: " + s.key + (s.paseoAgentId ? " (" + s.paseoAgentId + ")" : "");
    var mchip = document.getElementById("h-model");
    if (mchip) mchip.textContent = s.usage && s.usage.model ? s.usage.model : "—";
    document.getElementById("h-branch").textContent = d.project.branch || "—";
  }
  function applyLabels() {
    var offEl = document.getElementById("offline-badge");
    if (offEl && offEl.style.display !== "none") {
      var offTxt = document.getElementById("offline-text");
      if (offTxt) offTxt.textContent = t("offline");
    }
    document.getElementById("live-text").textContent = document.getElementById("live").classList.contains("on") ? t("live") : t("snapshot");
    renderRail(DATA);
  }
  function render(d) {
    DATA = d;
    renderHeader(d);
    if (d.run) renderRun(d);
    renderOverview(d);
    renderLogs(d);
    renderDiffs(d);
    renderCritique(d);
    renderDebt(d);
    renderHistory(d);
    if (TAB === "arch") drawArch();   // v3: рендер архитектуры (схема/граф/таблица)
    applyLabels();
  }
  function setLang(l) {
    lang = l;
    localStorage.setItem("nf-lang", l);
    document.getElementById("l-ru").classList.toggle("active", l === "ru");
    document.getElementById("l-en").classList.toggle("active", l === "en");
    applyLabels();
  }
  function setTheme(mode) {
    localStorage.setItem("nf-theme", mode);
    document.body.classList.toggle("light", mode === "light");
  }
  if (localStorage.getItem("nf-theme") === "light") document.body.classList.add("light");

  if (!IS_FROZEN) {
    var startMs = DATA.task.startedAt ? new Date(DATA.task.startedAt).getTime() : Date.now();
  setInterval(function () {
    if (IS_FROZEN || DATA.task.status === "closed") return;
    var el = document.getElementById("elapsed");
    if (el) el.textContent = fmtDur(Math.max(0, Date.now() - startMs));
  }, 1000);
  setInterval(function () {
    if (IS_FROZEN) return;
    tickRun();
  }, 1000);
  }

  function setOffline(on) {
    var offEl = document.getElementById("offline-badge");
    var liveEl = document.getElementById("live");
    if (offEl) {
      offEl.style.display = on ? "inline-flex" : "none";
      var offTxt = document.getElementById("offline-text");
      if (offTxt) offTxt.textContent = t("offline");
    }
    if (liveEl) {
      liveEl.style.display = on ? "none" : "inline-flex";
    }
  }

  function setLive(on) {
    var b = document.getElementById("live");
    b.classList.toggle("on", on);
    document.getElementById("live-text").textContent = on ? t("live") : t("snapshot");
  }
  function fp(d) {
    return JSON.stringify({ r: (d.run ? d.run.rev : ""), p: d.progress, s: d.stages.map(function (x) { return x.id + x.status; }), g: d.git.files.length + ":" + d.git.added, l: d.log.entries.length, e: (d.events || []).length, c: d.critique.length });
  }
  function flashChanged(d) {
    var f = fp(d);
    if (fingerprint !== null && f !== fingerprint) {
      ["tab-overview", "tab-logs", "tab-diffs"].forEach(function (id) {
        var el = document.getElementById(id);
        el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
      });
    }
    fingerprint = f;
  }
  function refreshNow() {
    if (IS_FROZEN) return;
    fetch("/api/state", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (fresh) {
        render(fresh);
        flashChanged(fresh);
        setLive(true);
        setOffline(false);
      })
      .catch(function () {
        setLive(false);
        if (window.NF_SNAPSHOT || IS_FROZEN) {
          setOffline(true);
        }
      });
  }
  function openDiff(file) {
    var modal = document.getElementById("modal");
    document.getElementById("modal-title").textContent = file;
    document.getElementById("modal-body").textContent = "Загрузка…";
    modal.classList.add("open");
    fetch("/api/diff?file=" + encodeURIComponent(file))
      .then(function (r) { return r.text(); })
      .then(function (text) {
        document.getElementById("modal-body").innerHTML = text.split("\\n").map(function (l) {
          var c = l.startsWith("+") && !l.startsWith("+++") ? "d-add" : l.startsWith("-") && !l.startsWith("---") ? "d-del" : l.startsWith("@@") ? "d-hunk" : "";
          var e = esc(l);
          return c ? '<span class="' + c + '">' + e + "</span>" : e;
        }).join("\\n");
      })
      .catch(function () { document.getElementById("modal-body").textContent = "Дифф доступен только в живом режиме"; });
  }
  function closeModal() { document.getElementById("modal").classList.remove("open"); }
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModal(); });

  function boot() {
    try {
      if (IS_FROZEN) setOffline(true);
      render(DATA);
      fingerprint = fp(DATA);
      showTab(TAB);
    } catch (e) {
      // Никогда не оставляем пустой экран без объяснения.
      var b = document.createElement("div");
      b.style.cssText = "position:fixed;bottom:12px;left:12px;right:12px;z-index:99;background:#2d1214;border:1px solid #ff5f56;color:#ffb3ae;font-family:var(--mono);font-size:12px;padding:10px 14px;border-radius:10px";
      b.textContent = "dashboard render error: " + (e && e.message ? e.message : e);
      document.body.appendChild(b);
      try { console.error("dashboard render error", e); } catch (_) {}
    }
  }
  boot();
  if (!IS_FROZEN) {
    refreshNow();
    setInterval(refreshNow, POLL_MS);
  }
</script>
</body>
</html>`;
}
