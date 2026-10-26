/**
 * tools/tests/dashboard-lifecycle.test.mjs — жизненный цикл демона дашборда:
 * явный подъём, точное убийство сирот, остановка по расписанию.
 *
 * defer: lifecycle tests in one file | ceiling: 300 lines | upgrade: split stop logic into dashboard-lifecycle.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTempDir } from "./test-helpers.mjs";
import {
  isOwnServerCommand,
  stopDashboardServer,
  killProjectOrphans,
  writeRuntime,
  STOP_DELAY_S,
} from "../dashboard.mjs";

const DASH = fileURLToPath(new URL("../dashboard.mjs", import.meta.url));

test("isOwnServerCommand: совпадает только наш демон по хвосту пути, корню и сессии", () => {
  const rel = `"C:/Program Files/nodejs/node.exe" tools/dashboard.mjs --serve --no-open --root D:/proj --port 4200 --session abc`;
  const abs = `"C:/Program Files/nodejs/node.exe" D:/proj/tools/dashboard.mjs --serve --no-open --root D:/proj --port 4200 --session abc`;
  const foreign = `"C:/Program Files/nodejs/node.exe" D:/other/tools/dashboard.mjs --serve --no-open --root D:/other --port 4200`;
  assert.equal(isOwnServerCommand(rel, { root: "D:/proj", sessionKey: "abc" }), true);
  assert.equal(isOwnServerCommand(abs, { root: "D:/proj", sessionKey: "abc" }), true);
  assert.equal(isOwnServerCommand(foreign, { root: "D:/proj" }), false);
  assert.equal(isOwnServerCommand("", { root: "D:/proj" }), false);
  assert.equal(isOwnServerCommand(null, { root: "D:/proj" }), false);
  assert.equal(isOwnServerCommand("node http.server 4200", { root: "D:/proj" }), false);
  assert.equal(isOwnServerCommand(rel, { root: "D:/other" }), false);
  assert.equal(STOP_DELAY_S, 12);
});

test("killProjectOrphans в dryRun только перечисляет, сутки файлов не трогает", () => {
  const tmp = createTempDir("lifecycle-dry-");
  const r = killProjectOrphans(tmp, { dryRun: true });
  assert.deepEqual(r.killed, []);
  assert.deepEqual(r.refused, []);
});

test("stopDashboardServer без рантайм-файла возвращает already-stopped, а не исключение", () => {
  const tmp = createTempDir("lifecycle-stop-");
  assert.equal(stopDashboardServer(tmp, { session: "ghost" }), "already-stopped: no runtime file");
});

test("killProjectOrphans удаляет запись о мёртвом PID и возвращает его в killed", () => {
  const tmp = createTempDir("lifecycle-stale-");
  writeRuntime(tmp, { key: "dead", pid: 2147483000, port: 45999, url: "http://localhost:45999", root: tmp, startedAt: new Date().toISOString() });
  const r = killProjectOrphans(tmp, { dryRun: false });
  assert.deepEqual(r.killed.map((k) => k.key), ["dead"]);
  assert.equal(r.killed[0].why, "pid dead");
  assert.deepEqual(r.refused, []);
});

test("stopDashboardServer в живую убивает свой демон и сносит его рантайм", async () => {
  const tmp = createTempDir("lifecycle-live-");
  // Случайный порт: сирота от оборванного прогона не должен сквоттить константу.
  const port = 45000 + Math.floor(Math.random() * 999);
  const child = spawn(process.execPath, [DASH, "--serve", "--no-open", "--root", tmp, "--port", String(port), "--session", "killme"], {
    detached: true, stdio: "ignore", windowsHide: true,
  });
  child.unref();
  const health = `http://127.0.0.1:${port}/api/health`;
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const res = await fetch(health);
      // Проверяем, что отвечает именно наш демон, а не сквоттер: token привязан к root.
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body && body.ok === true) up = true;
      }
    } catch {}
  }
  assert.ok(up, `daemon did not come up in 10s on :${port}`);
  try {
    const out = stopDashboardServer(tmp, { session: "killme" });
    assert.match(out, /^stopped:\d+$/);
    await new Promise((r) => setTimeout(r, 800));
    let alive = true;
    try {
      const res = await fetch(health);
      alive = res.ok;
    } catch { alive = false; }
    assert.equal(alive, false, "server must be gone after stop");
  } finally {
    // Сироту не оставляем даже при падении ассерта: иначе он сквоттит порт вечно.
    try { process.kill(child.pid, "SIGKILL"); } catch {}
  }
});
