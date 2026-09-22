/**
 * fix-plugin-windows.cjs — убирает мигающие окна консоли Windows у установленных
 * OMP-плагинов: добавляет `windowsHide: true` в опции spawn/execFile.
 *
 * Причина: Paseo — GUI-приложение без своей консоли. Любой дочерний процесс,
 * запущенный без `windowsHide`, получает НОВОЕ окно консоли: оно появляется и
 * сразу закрывается. Чаще всего это пробы python/pip/npm в pi-lens (`shell: true`)
 * и спавн агентских процессов в @plannotator.
 *
 * Безопасность:
 *   • правим только реальный код (маска комментариев/строк);
 *   • только вызовы с `shell: true` или `detached: true` — именно они дают окно;
 *   • каждый .js после правки проверяется `node --check`; при провале файл
 *     восстанавливается из бэкапа и правка отклоняется.
 * Идемпотентно; бэкап — `<file>.bak-win`.
 *
 *   node fix-plugin-windows.cjs [--dry-run]
 *
 * Ограничение: правки в node_modules теряются при обновлении плагина —
 * запускайте после `omp plugin install/upgrade`.
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const DRY = process.argv.includes("--dry-run");
const PLUGINS_ROOT = path.join(os.homedir(), ".omp", "plugins", "node_modules");
const TARGETS = [
  "pi-lens/dist/clients/installer/index.js",
  "@plannotator/pi-extension/generated/ai/providers/codex-app-server.ts",
  "@plannotator/pi-extension/generated/ai/providers/pi-sdk-node.ts",
];

/** Маска: 1 — позиция внутри комментария/строки/шаблона (править нельзя). */
function codeMask(src) {
  const mask = new Uint8Array(src.length);
  let mode = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === "line") { if (c === "\n") mode = null; else mask[i] = 1; continue; }
    if (mode === "block") { mask[i] = 1; if (c === "*" && n === "/") { mask[i + 1] = 1; i++; mode = null; } continue; }
    if (mode) {
      mask[i] = 1;
      if (c === "\\") { mask[i + 1] = 1; i++; continue; }
      if ((mode === "single" && c === "'") || (mode === "double" && c === '"') || (mode === "template" && c === "`")) mode = null;
      continue;
    }
    if (c === "/" && n === "/") { mask[i] = mask[i + 1] = 1; i++; mode = "line"; continue; }
    if (c === "/" && n === "*") { mask[i] = mask[i + 1] = 1; i++; mode = "block"; continue; }
    if (c === "'") { mask[i] = 1; mode = "single"; continue; }
    if (c === '"') { mask[i] = 1; mode = "double"; continue; }
    if (c === "`") { mask[i] = 1; mode = "template"; continue; }
  }
  return mask;
}

function blockEnd(src, mask, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (mask[i]) continue;
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** План правки для одного вызова: вставить свойство перед закрывающей скобкой. */
function planEdit(src, mask, open, end) {
  const block = src.slice(open, end + 1);
  if (/windowsHide/.test(block)) return null;
  if (!/shell\s*:\s*(true|isWin|isWindows|process\.platform|installerPlatform)/.test(block) && !/detached\s*:\s*true/.test(block)) return null;

  const before = src.slice(open, end);              // "...{ ... props ...      "
  const lines = before.split("\n");
  // Отступ последнего свойства (строка перед закрывающей скобкой)
  let propIndent = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^([ \t]+)\S/);
    if (m) { propIndent = m[1]; break; }
  }
  if (!propIndent) propIndent = "  ";

  const lastNl = before.lastIndexOf("\n");
  const insertAt = open + lastNl + 1;               // начало строки с "}"
  const head = src.slice(open, insertAt);           // до строки с "}"
  const tail = src.slice(insertAt, end + 1);        // "}" (+пробелы)

  // Предыдущее свойство должно заканчиваться запятой
  const needsComma = !/,\s*(\n\s*)$/.test(head);
  const fixedHead = needsComma ? head.replace(/\s*$/, "") + ",\n" : head;

  return { start: open, end: end + 1, text: fixedHead + propIndent + "windowsHide: true,\n" + tail };
}

let total = 0;
const report = [];

for (const rel of TARGETS) {
  const file = path.join(PLUGINS_ROOT, rel);
  if (!fs.existsSync(file)) { report.push(["нет файла", rel]); continue; }

  const original = fs.readFileSync(file, "utf8");
  const mask = codeMask(original);
  const callRe = /\b(spawn|spawnSync|execFile|execFileSync)\s*\(/g;
  const edits = [];
  let m;
  while ((m = callRe.exec(original)) !== null) {
    if (mask[m.index]) continue;
    let open = -1;
    for (let i = m.index + m[0].length; i < Math.min(original.length, m.index + 300); i++) {
      if (mask[i]) continue;
      if (original[i] === "{") { open = i; break; }
      if (original[i] === ")") break;
    }
    if (open === -1) continue;
    const end = blockEnd(original, mask, open);
    if (end === -1) continue;
    const plan = planEdit(original, mask, open, end);
    if (plan) edits.push(plan);
  }

  if (edits.length === 0) { report.push(["нечего править", rel]); continue; }

  let patched = original;
  for (const e of edits.reverse()) patched = patched.slice(0, e.start) + e.text + patched.slice(e.end);

  // Проверка: .js — node --check; .ts — баланс скобок
  let ok = true;
  let reason = "";
  if (rel.endsWith(".js")) {
    const tmp = file + ".check.tmp.js";
    fs.writeFileSync(tmp, patched, "utf8");
    const res = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
    fs.unlinkSync(tmp);
    if (res.status !== 0) { ok = false; reason = (res.stderr || "").split("\n").filter(Boolean).slice(-2).join(" "); }
  } else {
    const count = (s, ch) => (s.match(new RegExp("\\" + ch, "g")) || []).length;
    ok = count(patched, "{") === count(patched, "}") && count(patched, "(") === count(patched, ")");
    if (!ok) reason = "разбалансированы скобки";
  }

  if (!ok) { report.push([`ОТКЛОНЕНО: ${reason}`, rel]); continue; }

  if (!DRY) {
    const bak = file + ".bak-win";
    if (!fs.existsSync(bak)) fs.writeFileSync(bak, original, "utf8");
    fs.writeFileSync(file, patched, "utf8");
  }
  total += edits.length;
  report.push([`windowsHide добавлен: ${edits.length}`, rel]);
}

console.log(DRY ? "DRY-RUN (ничего не записано)" : "Патч применён");
for (const [status, file] of report) console.log(`  ${status.padEnd(30)} ${file}`);
console.log(`Итого правок: ${total}`);
