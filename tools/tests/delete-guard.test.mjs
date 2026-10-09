import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  RULES,
  matchDestructiveCommand,
  rmTargets,
  computeRmScope,
  buildDenyMessage,
  extractCommand,
  handleSessionStart,
  handleToolCall,
  setInteractive,
  getInteractive,
  createDeleteGuardExtension,
} from "../../agent/extensions/nullform-delete-guard.ts";
import { installHarness } from "../install-harness.mjs";

test("Rule 1 (rm recursive): matches recursive flags and rejects non-recursive rm", () => {
  const rule = RULES[0];
  assert.equal(rule.what, "удалить папку целиком");

  // Positive cases: rm with -r, -R, -rf, -fr, -v -R, --recursive
  assert.ok(rule.re.test("rm -rf ./build"));
  assert.ok(rule.re.test("rm -r node_modules"));
  assert.ok(rule.re.test("rm -R /tmp/cache"));
  assert.ok(rule.re.test("rm -f -r dir"));
  assert.ok(rule.re.test("rm -v -R dir"));
  assert.ok(rule.re.test("rm --recursive temp"));
  assert.ok(rule.re.test("rm -fr /data"));

  // Negative cases: rm without recursion flag
  assert.ok(!rule.re.test("rm file.txt"));
  assert.ok(!rule.re.test("rm -f file.txt"));
  assert.ok(!rule.re.test("rm -i file.txt"));
  assert.ok(!rule.re.test("rm -v file.txt"));
});

test("Rule 2 (git push --force): matches force push and rejects normal push", () => {
  const rule = RULES[1];
  assert.equal(rule.what, "перезаписать историю на сервере (force push)");

  // Positive cases
  assert.ok(rule.re.test("git push origin main -f"));
  assert.ok(rule.re.test("git push --force"));
  assert.ok(rule.re.test("git push origin main --force"));
  assert.ok(rule.re.test("git push -f origin feat"));

  // Negative cases
  assert.ok(!rule.re.test("git push"));
  assert.ok(!rule.re.test("git push origin main"));
  assert.ok(!rule.re.test("git push -u origin feature"));
});

test("Rule 3 (git reset --hard): matches reset hard and rejects soft/mixed reset", () => {
  const rule = RULES[2];
  assert.equal(rule.what, "стереть несохранённые правки (git reset --hard)");

  // Positive cases
  assert.ok(rule.re.test("git reset --hard"));
  assert.ok(rule.re.test("git reset --hard HEAD~1"));
  assert.ok(rule.re.test("git reset --hard origin/main"));

  // Negative cases
  assert.ok(!rule.re.test("git reset"));
  assert.ok(!rule.re.test("git reset --soft HEAD~1"));
  assert.ok(!rule.re.test("git reset HEAD"));
});

test("Rule 4 (git clean -f): matches force clean and rejects dry-run", () => {
  const rule = RULES[3];
  assert.equal(rule.what, "удалить неотслеживаемые файлы (git clean)");

  // Positive cases
  assert.ok(rule.re.test("git clean -f"));
  assert.ok(rule.re.test("git clean -fd"));
  assert.ok(rule.re.test("git clean -xdf"));
  assert.ok(rule.re.test("git clean -df"));

  // Negative cases
  assert.ok(!rule.re.test("git clean -n"));
  assert.ok(!rule.re.test("git clean --dry-run"));
});

test("Rule 5 (find -delete): matches find with -delete and rejects normal find", () => {
  const rule = RULES[4];
  assert.equal(rule.what, "удалить найденные файлы (find -delete)");

  // Positive cases
  assert.ok(rule.re.test("find . -name '*.log' -delete"));
  assert.ok(rule.re.test("find /tmp -type f -delete"));

  // Negative cases
  assert.ok(!rule.re.test("find . -name '*.log'"));
  assert.ok(!rule.re.test("find /tmp -type f"));
  assert.ok(!rule.re.test("find . -print"));
});

test("Rule 6 (DB drop/truncate): matches DROP/TRUNCATE and rejects SELECT/DELETE", () => {
  const rule = RULES[5];
  assert.equal(rule.what, "удалить данные из базы");

  // Positive cases (case insensitive)
  assert.ok(rule.re.test("drop table users"));
  assert.ok(rule.re.test("DROP DATABASE test_db"));
  assert.ok(rule.re.test("drop schema public"));
  assert.ok(rule.re.test("truncate table sessions"));
  assert.ok(rule.re.test("TRUNCATE TABLE logs"));

  // Negative cases
  assert.ok(!rule.re.test("select * from users"));
  assert.ok(!rule.re.test("delete from users where id = 1"));
  assert.ok(!rule.re.test("update table_config set active = 1"));
});

test("matchDestructiveCommand identifies destructive rules and ignores safe commands", () => {
  const m1 = matchDestructiveCommand("rm -rf ./dist");
  assert.ok(m1);
  assert.equal(m1.what, "удалить папку целиком");

  const m2 = matchDestructiveCommand("git push --force");
  assert.ok(m2);
  assert.equal(m2.what, "перезаписать историю на сервере (force push)");

  assert.equal(matchDestructiveCommand("ls -la"), null);
  assert.equal(matchDestructiveCommand("cat README.md"), null);
  assert.equal(matchDestructiveCommand("git status"), null);
});

test("rmTargets parses arguments, flags, quotes, and expands ~", () => {
  const home = "/mock/home";

  // Extracts paths, strips options
  const targets1 = rmTargets("rm -rf ./build /tmp/cache", home);
  assert.deepEqual(targets1, ["./build", "/tmp/cache"]);

  // Strips single and double quotes
  const targets2 = rmTargets("rm -r 'dir1' \"dir2\"", home);
  assert.deepEqual(targets2, ["dir1", "dir2"]);

  // Expands ~ and ~/
  const targets3 = rmTargets("rm -rf ~/projects ~", home);
  assert.deepEqual(targets3, ["/mock/home/projects", "/mock/home"]);

  // Non-rm command returns empty array
  assert.deepEqual(rmTargets("git status", home), []);

  // Caps at 10 targets
  const many = "rm -rf " + Array.from({ length: 15 }, (_, i) => `dir${i}`).join(" ");
  assert.equal(rmTargets(many, home).length, 10);
});

test("computeRmScope counts files and size with ctx.exec or falls back gracefully", async () => {
  // Successful execution with ctx.exec
  const mockCtx = {
    exec: async (cmd) => {
      if (cmd === "find") {
        return { stdout: "f1\nf2\nf3\n" };
      }
      if (cmd === "du") {
        return { stdout: " 12M\ttotal\n" };
      }
      return { stdout: "" };
    },
  };

  const scope = await computeRmScope("rm -rf ./dir", mockCtx, "/home");
  assert.equal(scope, " — 3 файлов, 12M");

  // Fallback when exec throws
  const failingCtx = {
    exec: async () => {
      throw new Error("Command not found: find");
    },
  };
  const fallbackScope = await computeRmScope("rm -rf ./dir", failingCtx, "/home");
  assert.equal(fallbackScope, "");

  // Fallback when no targets
  assert.equal(await computeRmScope("rm -rf", mockCtx, "/home"), "");
});

test("buildDenyMessage returns exact Russian safety prompt text", () => {
  const msg = buildDenyMessage("удалить папку целиком");
  assert.equal(
    msg,
    "Страж удаления: пользователь отменил «удалить папку целиком». Не повторяй эту команду; предложи безопасный вариант (копия, корзина) и спроси."
  );
});

test("extractCommand extracts commands from bash and eval tool calls", () => {
  assert.equal(extractCommand({ toolName: "bash", input: { command: "rm -rf dist" } }), "rm -rf dist");
  assert.equal(extractCommand({ toolName: "bash", args: { command: "rm -rf dist" } }), "rm -rf dist");
  assert.equal(extractCommand({ toolName: "eval", input: { code: "drop table users" } }), "drop table users");
  assert.equal(extractCommand({ toolName: "read", input: { path: "foo.txt" } }), null);
  assert.equal(extractCommand(null), null);
});

test("handleSessionStart toggles isInteractive state based on event or ctx", () => {
  setInteractive(true);
  assert.equal(getInteractive(), true);

  handleSessionStart({ isInteractive: false });
  assert.equal(getInteractive(), false);

  handleSessionStart({ isInteractive: true });
  assert.equal(getInteractive(), true);

  handleSessionStart(undefined, { hasUI: false });
  assert.equal(getInteractive(), false);

  handleSessionStart(undefined, { hasUI: true, mode: "tui" });
  assert.equal(getInteractive(), true);

  handleSessionStart(undefined, { hasUI: true, mode: "print" });
  assert.equal(getInteractive(), false);
});

test("handleToolCall prompts via ctx.ui.confirm when interactive and allows on true", async () => {
  setInteractive(true);

  let confirmCalled = false;
  let passedTitle = "";
  let passedMessage = "";

  const mockCtx = {
    ui: {
      confirm: async (title, message) => {
        confirmCalled = true;
        passedTitle = title;
        passedMessage = message;
        return true;
      },
    },
  };

  const result = await handleToolCall(
    { toolName: "bash", input: { command: "rm -rf ./build" } },
    mockCtx
  );

  assert.equal(confirmCalled, true);
  assert.equal(passedTitle, "Страж");
  assert.ok(passedMessage.includes("удалить папку целиком"));
  assert.ok(passedMessage.includes("rm -rf ./build"));
  assert.equal(result, undefined);
});

test("handleToolCall blocks with deny message when ctx.ui.confirm returns false", async () => {
  setInteractive(true);

  const mockCtx = {
    ui: {
      confirm: async () => false,
    },
  };

  const result = await handleToolCall(
    { toolName: "bash", input: { command: "git push origin main --force" } },
    mockCtx
  );

  assert.ok(result);
  assert.equal(result.block, true);
  assert.ok(result.reason.includes("Страж удаления: пользователь отменил «перезаписать историю на сервере (force push)»"));
  assert.equal(result.deny, result.reason);
});

test("handleToolCall blocks when ctx.ui.confirm throws error (dialog closed)", async () => {
  setInteractive(true);

  const mockCtx = {
    ui: {
      confirm: async () => {
        throw new Error("Dialog aborted by user");
      },
    },
  };

  const result = await handleToolCall(
    { toolName: "bash", input: { command: "git reset --hard" } },
    mockCtx
  );

  assert.ok(result);
  assert.equal(result.block, true);
  assert.ok(result.reason.includes("стереть несохранённые правки (git reset --hard)"));
});

test("handleToolCall supports ctx.ui.ask fallback", async () => {
  setInteractive(true);

  const mockCtx = {
    ui: {
      ask: async () => "Отменить",
    },
  };

  const result = await handleToolCall(
    { toolName: "bash", input: { command: "git clean -f" } },
    mockCtx
  );

  assert.ok(result);
  assert.equal(result.block, true);
  assert.ok(result.reason.includes("удалить неотслеживаемые файлы (git clean)"));
});

test("handleToolCall skips guard in non-interactive sessions", async () => {
  setInteractive(false);

  let confirmCalled = false;
  const mockCtx = {
    ui: {
      confirm: async () => {
        confirmCalled = true;
        return false;
      },
    },
  };

  const result = await handleToolCall(
    { toolName: "bash", input: { command: "rm -rf ./build" } },
    mockCtx
  );

  assert.equal(confirmCalled, false);
  assert.equal(result, undefined);

  // Restore interactive mode
  setInteractive(true);
});

test("createDeleteGuardExtension registers event handlers on ExtensionAPI", () => {
  const registeredEvents = [];
  const mockPi = {
    on: (name, handler) => {
      registeredEvents.push({ name, handler });
    },
  };

  const ext = createDeleteGuardExtension();
  ext(mockPi);

  const eventNames = registeredEvents.map((r) => r.name);
  assert.ok(eventNames.includes("session_start"));
  assert.ok(eventNames.includes("tool_call"));
});

test("installHarness plans and copies nullform-delete-guard.ts alongside nullform-jev.ts", () => {
  const tempDir = join(tmpdir(), `test-delete-guard-install-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });

  try {
    const plan = installHarness({
      userHome: tempDir,
      targetHarnesses: ["omp"],
      writeHome: true,
      dryRun: true,
    });

    const expectedDest = join(tempDir, ".omp", "agent", "extensions", "nullform-delete-guard.ts");
    assert.ok(
      plan.filesToCopy.some((f) => f.includes("nullform-delete-guard.ts")),
      "installHarness plan must include nullform-delete-guard.ts"
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
