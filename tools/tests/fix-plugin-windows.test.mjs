/**
 * tools/tests/fix-plugin-windows.test.mjs — тесты патчера плагинных окон Windows.
 *
 * Проверяем на фикстурах: правка вставляется только в реальный код, комментарии
 * и строки не трогаются, вызовы без shell/detached игнорируются, идемпотентность
 * и отклонение правки, ломающей синтаксис.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MOD = await import("../fix-plugin-windows.mjs").catch(() => null);

/* Патчер распространяется как .cjs-скрипт; для тестов переиспользуем его ядро
   через прямой импорт функций, если модуль экспортирует их, иначе — через
   прогон CLI на фикстуре. Здесь проверяем CLI-поведение, потому что именно оно
   поставляется пользователю. */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../fix-plugin-windows.cjs", import.meta.url));

/** Фикстура: временный «plugins root» с одним плагином. */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "plugwin-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, ".omp", "plugins", "node_modules", rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return root;
}

test("fix-plugin-windows: добавляет windowsHide только в shell-true вызовы, не трогая комментарии", () => {
  const src = [
    "function runCommand(command, args, cwd) {",
    "    // Example: spawn(command, args, { shell: true }) in a comment",
    "    return new Promise((resolve) => {",
    "        let proc;",
    "        try {",
    "            proc = spawn(command, args, {",
    "                cwd,",
    '                stdio: "ignore",',
    '                shell: process.platform === "win32",',
    "            });",
    "        }",
    "        catch {",
    "            resolve(false);",
    "        }",
    "    });",
    "}",
    "function plain(command) {",
    "    // spawn(command, { stdio: 'ignore' }) — без shell окна нет",
    "    return spawn(command, { stdio: 'ignore' });",
    "}",
    "",
  ].join("\n");

  const root = fixture({ "pi-lens/dist/clients/installer/index.js": src });
  try {
    // Патчер смотрит в ~/.omp/plugins; для теста подменяем HOME
    const res = spawnSync(process.execPath, [CLI], {
      encoding: "utf8",
      env: { ...process.env, USERPROFILE: root, HOME: root },
    });
    const patched = readFileSync(join(root, ".omp", "plugins", "node_modules", "pi-lens", "dist", "clients", "installer", "index.js"), "utf8");

    // Вызов с shell:true получил windowsHide
    assert.equal((patched.match(/windowsHide: true,/g) || []).length, 1, "ровно одна правка");
    assert.ok(patched.includes('shell: process.platform === "win32",\n                windowsHide: true,'), "свойство вставлено в опции");

    // Комментарий не тронут
    assert.ok(
      patched.includes("// Example: spawn(command, args, { shell: true }) in a comment"),
      "текст комментария не изменён"
    );

    // Вызов без shell/detached не тронут
    assert.ok(patched.includes("return spawn(command, { stdio: 'ignore' });"), "вызов без shell не патчится");

    // Бэкап создан
    assert.ok(readFileSync(join(root, ".omp", "plugins", "node_modules", "pi-lens", "dist", "clients", "installer", "index.js.bak-win"), "utf8").includes(src.slice(0, 40)));

    // Идемпотентность: второй прогон ничего не меняет
    const before = patched;
    spawnSync(process.execPath, [CLI], { encoding: "utf8", env: { ...process.env, USERPROFILE: root, HOME: root } });
    assert.equal(readFileSync(join(root, ".omp", "plugins", "node_modules", "pi-lens", "dist", "clients", "installer", "index.js"), "utf8"), before, "повторный прогон идемпотентен");
    assert.ok(res.stdout.includes("windowsHide добавлен"), "отчёт о правке");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fix-plugin-windows: правка, ломающая синтаксис, отклоняется (файл не портится)", () => {
  // Вызов в объекте, где закрывающая скобка принадлежит не опциям, а выражению:
  // патчер обязан либо пропустить его, либо откатиться по node --check.
  const src = [
    "const x = spawn(cmd, args, {",
    "  shell: true,",
    "});",
    "function broken( {",
    "  // незакрытая фигурная скобка в конце файла делает файл невалидным заранее",
    "",
  ].join("\n");

  const root = fixture({ "pi-lens/dist/clients/installer/index.js": src });
  try {
    const before = src;
    const res = spawnSync(process.execPath, [CLI], {
      encoding: "utf8",
      env: { ...process.env, USERPROFILE: root, HOME: root },
    });
    const after = readFileSync(join(root, ".omp", "plugins", "node_modules", "pi-lens", "dist", "clients", "installer", "index.js"), "utf8");
    // Изначально файл невалиден → правка не должна применяться молча
    assert.equal(after, before, "невалидный файл остаётся неизменным");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fix-plugin-windows: patchPiLensEpipe глушит EPIPE/broken pipe в pi-lens", () => {
  const src = [
    "var WritableStreamWrapper = class {",
    "  write(data, encoding) {",
    "    if (this.stream && !this.stream._hasLspEpipeHandler) {",
    "      this.stream._hasLspEpipeHandler = true;",
    "      this.stream.on?.('error', () => {});",
    "    }",
    "    return new Promise((resolve136, reject) => {",
    "      const callback = (error) => {",
    "        if (error === void 0 || error === null) {",
    "          resolve136();",
    "        } else {",
    "          reject(error);",
    "        }",
    "      };",
    "      if (typeof data === 'string') {",
    "        this.stream.write(data, encoding, callback);",
    "      } else {",
    "        this.stream.write(data, callback);",
    "      }",
    "    });",
    "  }",
    "};",
    "var WriteableStreamMessageWriter = class {",
    "  async doWrite(msg, headers, data) {",
    "    try {",
    "      await this.writable.write(headers.join(''), 'ascii');",
    "      return await this.writable.write(data);",
    "    } catch (error) {",
    "      this.handleError(error, msg);",
    "      return Promise.reject(error);",
    "    }",
    "  }",
    "};",
  ].join("\n");

  const root = fixture({ "pi-lens/dist/index.js": src });
  try {
    const res = spawnSync(process.execPath, [CLI], {
      encoding: "utf8",
      env: { ...process.env, USERPROFILE: root, HOME: root },
    });
    const patched = readFileSync(join(root, ".omp", "plugins", "node_modules", "pi-lens", "dist", "index.js"), "utf8");

    assert.ok(patched.includes("patched-epipe-handler"), "маркер патча добавлен");
    assert.ok(patched.includes('error?.code === "EPIPE"'), "проверка EPIPE добавлена в callback");
    assert.ok(patched.includes("resolve136();"), "resolve136 вызывается при EPIPE");
    assert.ok(res.stdout.includes("EPIPE-глушитель добавлен: 2"), "отчёт CLI о правке EPIPE");

    // Идемпотентность: второй прогон
    const res2 = spawnSync(process.execPath, [CLI], {
      encoding: "utf8",
      env: { ...process.env, USERPROFILE: root, HOME: root },
    });
    assert.ok(res2.stdout.includes("уже пропатчен (EPIPE)"), "повторный прогон идемпотентен");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
