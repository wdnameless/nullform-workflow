import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function transpileDeleteGuardTs(src) {
  return src
    .replace(/import\s+type\s*[\s\S]*?from\s*["'][^"']+["'];?/g, "")
    .replace(/export\s+interface\s+[A-Za-z0-9_]+\s*\{[\s\S]*?\}/g, "")
    .replace(/export const RULES: DestructiveRule\[\] =/, "export const RULES =")
    .replace(/const GIT_RESTORATION: DestructiveRule =/, "const GIT_RESTORATION =")
    .replace(/export function setInteractive\(value: boolean\): void \{/, "export function setInteractive(value) {")
    .replace(/export function getInteractive\(\): boolean \{/, "export function getInteractive() {")
    .replace(/export function matchDestructiveCommand\(cmd: string\): \{ what: string; rule\?: DestructiveRule \} \| null \{/, "export function matchDestructiveCommand(cmd) {")
    .replace(/export function rmTargets\(\s*cmd: string,\s*home: string \| undefined =/, "export function rmTargets(\n  cmd,\n  home =")
    .replace(/\): string\[\] \{/, ") {")
    .replace(/async function runExecHelper\(\s*execFn: Function,\s*cmd: string,\s*args: string\[\],\s*timeoutMs: number\s*\): Promise<\{ stdout: string; stderr\?: string \} \| null> \{/, "async function runExecHelper(\n  execFn,\n  cmd,\n  args,\n  timeoutMs\n) {")
    .replace(/const parseResult = \(res: unknown\): \{ stdout: string; stderr\?: string \} \| null => \{/, "const parseResult = (res) => {")
    .replace(/export async function computeRmScope\(\s*cmd: string,\s*ctx\?: unknown,\s*home\?: string\s*\): Promise<string> \{/, "export async function computeRmScope(\n  cmd,\n  ctx,\n  home\n) {")
    .replace(/export function buildDenyMessage\(what: string\): string \{/, "export function buildDenyMessage(what) {")
    .replace(/export function extractCommand\(event: unknown\): string \| null \{/, "export function extractCommand(event) {")
    .replace(/export function handleSessionStart\(event\?: unknown, ctx\?: unknown\): void \{/, "export function handleSessionStart(event, ctx) {")
    .replace(/export async function handleToolCall\(\s*event: unknown,\s*ctx\?: unknown\s*\): Promise<DeleteGuardResult \| undefined> \{/, "export async function handleToolCall(\n  event,\n  ctx\n) {")
    .replace(/let home: string \| undefined;/, "let home;")
    .replace(/deleteGuardExtension\(pi: ExtensionAPI\): void \{/, "deleteGuardExtension(pi) {")
    .replace(/\(event: SessionStartEvent, ctx: ExtensionContext\) => \{/, "(event, ctx) => {")
    .replace(/\(event: ToolCallEvent, ctx: ExtensionContext\): Promise<ToolCallEventResult \| void> => \{/, "(event, ctx) => {");
}

async function loadDeleteGuard() {
  try {
    return await import("../../agent/extensions/nullform-delete-guard.ts");
  } catch (err) {
    if (err && (err.code === "ERR_UNKNOWN_FILE_EXTENSION" || String(err).includes("Unknown file extension"))) {
      const targetPath = fileURLToPath(new URL("../../agent/extensions/nullform-delete-guard.ts", import.meta.url));
      const src = readFileSync(targetPath, "utf8");
      const js = transpileDeleteGuardTs(src);
      return await import("data:text/javascript," + encodeURIComponent(js));
    }
    throw err;
   }
}

const {
  matchDestructiveCommand,
  rmTargets,
  computeRmScope,
  extractCommand,
  handleSessionStart,
  handleToolCall,
  setInteractive,
} = await loadDeleteGuard();

test("existing destructive operations still classify their dangerous flags, not safe variants", () => {
  const dangerous = [
    "rm -rf ./build", "rm -r node_modules", "rm -R /tmp/cache", "rm -f -r dir",
    "rm -v -R dir", "rm --recursive temp", "rm -fr /data",
    "git push origin main -f", "git push --force", "git push origin main --force",
    "git push -f origin feat", "git reset --hard", "git reset --hard HEAD~1",
    "git reset --hard origin/main", "git clean -f", "git clean -fd", "git clean -xdf",
    "git clean -df", "find . -name '*.log' -delete", "find /tmp -type f -delete",
    "drop table users", "DROP DATABASE test_db", "drop schema public",
    "truncate table sessions", "TRUNCATE TABLE logs",
  ];
  const safe = [
    "rm file.txt", "rm -f file.txt", "rm -i file.txt", "rm -v file.txt",
    "git push", "git push origin main", "git push -u origin feature",
    "git reset", "git reset --soft HEAD~1", "git reset HEAD",
    "git clean -n", "git clean --dry-run", "find . -name '*.log'",
    "find /tmp -type f", "find . -print", "select * from users",
    "delete from users where id = 1", "update table_config set active = 1",
  ];
  for (const command of dangerous) assert.ok(matchDestructiveCommand(command), command);
  for (const command of safe) assert.equal(matchDestructiveCommand(command), null, command);
});

const screenshotCommand = "git checkout stash@{0} -- src/App.tsx";
const restorations = [
  screenshotCommand, "git checkout -- src/App.tsx", "git checkout src/App.tsx",
  "git checkout -f HEAD", "git restore src/App.tsx", "git restore --staged src/App.tsx",
  "git restore --source=HEAD --worktree --staged -- .",
  "git stash apply stash@{0}", "git stash pop", "git stash push -u",
  "git stash", "git stash -u", "git stash save backup", "git stash branch rescue",
  'git -C "repo with spaces" checkout stash@{0} -- src/App.tsx',
  "git -Crepo -c core.autocrlf=false restore -- .",
  'git -C"repo with spaces" -P restore -- .',
  "git --no-replace-objects stash pop",
  "git --git-dir=.git --work-tree=. restore --staged -- .",
  "git --git-dir .git --work-tree . stash pop",
  "git --no-pager --literal-pathspecs -C repo restore -- .",
  "env GIT_OPTIONAL_LOCKS=0 command git -C repo stash apply",
  "sudo -u worker git -c core.quotePath=false checkout -- file",
  'bash -lc "git -C repo stash push"',
  '& "C:/Program Files/Git/bin/git.exe" -C repo restore -- file',
  "rm -rf build && git restore -- .",
];

test("Git restoration blocks headlessly even after another destructive match", async () => {
  setInteractive(false);
  try {
    for (const command of restorations) {
      const result = await handleToolCall({ toolName: "bash", input: { command } }, {
        ui: { confirm: () => assert.fail("headless confirmation must not run") },
      });
      assert.equal(result?.block, true, command);
      assert.equal(result.deny, result.reason);
    }
  } finally {
    setInteractive(true);
  }
});

test("safe Git inspection and isolated worktree creation remain usable", async () => {
  setInteractive(true);
  for (const command of [
    "git status", "git -C repo status --short", "git show stash@{0}:src/App.tsx",
    "git --no-pager diff -- src/App.tsx", "git stash show -p stash@{0}",
    "git stash list", "git stash create", "git worktree add --detach .tmp/worktrees/feature HEAD",
  ]) {
    assert.equal(await handleToolCall({ toolName: "bash", input: { command } }, {
      hasUI: true, ui: { confirm: () => assert.fail(`safe command prompted: ${command}`) },
    }), undefined, command);
  }
});

test("screenshot restoration requires explicit interactive authorization", async () => {
  setInteractive(true);
  const event = { toolName: "bash", input: { command: screenshotCommand } };
  for (const answer of [false, undefined, "yes"]) {
    const result = await handleToolCall(event, { hasUI: true, ui: { confirm: async () => answer } });
    assert.equal(result?.block, true);
  }
  let prompts = 0;
  assert.equal(await handleToolCall(event, {
    hasUI: true, ui: { confirm: async () => { prompts++; return true; } },
  }), undefined);
  assert.equal(prompts, 1);
  assert.equal((await handleToolCall(event, { hasUI: false }))?.block, true);
  assert.equal((await handleToolCall(event, {}))?.block, true);
  assert.equal((await handleToolCall(event, {
    ui: { confirm: async () => { throw new Error("dismissed"); } },
  }))?.block, true);
  assert.equal(await handleToolCall(event, { ui: { ask: async () => "Выполнить" } }), undefined);
  assert.equal((await handleToolCall(event, { ui: { ask: async () => "Отменить" } }))?.block, true);
});

test("session modes deny Git restoration but preserve other headless permission behavior", async () => {
  const event = { toolName: "eval", input: { code: 'await shell("git restore --staged -- .")' } };
  try {
    for (const ctx of [{ hasUI: false }, { hasUI: true, mode: "print" }, { hasUI: true, mode: "rpc" }]) {
      handleSessionStart(undefined, ctx);
      assert.equal((await handleToolCall(event, ctx))?.block, true);
      assert.equal(await handleToolCall({ toolName: "bash", input: { command: "rm -rf build" } }, ctx), undefined);
    }
  } finally {
    setInteractive(true);
  }
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


test("extractCommand extracts commands from bash and eval tool calls", () => {
  assert.equal(extractCommand({ toolName: "bash", input: { command: "rm -rf dist" } }), "rm -rf dist");
  assert.equal(extractCommand({ toolName: "bash", args: { command: "rm -rf dist" } }), "rm -rf dist");
  assert.equal(extractCommand({ toolName: "eval", input: { code: "drop table users" } }), "drop table users");
  assert.equal(extractCommand({ toolName: "read", input: { path: "foo.txt" } }), null);
  assert.equal(extractCommand(null), null);
});


test("handleToolCall prompts via ctx.ui.confirm when interactive and allows on true", async () => {
  setInteractive(true);

  let confirmCalled = false;

  const mockCtx = {
    ui: {
      confirm: async () => {
        confirmCalled = true;
        return true;
      },
    },
  };

  const result = await handleToolCall(
    { toolName: "bash", input: { command: "rm -rf ./build" } },
    mockCtx
  );

  assert.equal(confirmCalled, true);
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

