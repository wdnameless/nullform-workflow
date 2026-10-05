#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const root = process.cwd();
const srcDir = join(root, "src");
mkdirSync(srcDir, { recursive: true });
writeFileSync(join(root, "manifest.md"), "# Constructed fixture requirements (synthetic scenario, not production user evidence)\n\nR01: Newly exported command variants work through the receiving command router.\nR02: Existing CSV/JSON routing remains intact.\nR03: Cloning preserves supported JavaScript values without a bespoke JSON wrapper.\n");

function git(cmd) {
  execSync(cmd, { cwd: root, stdio: "ignore" });
}

// 1. Initial commit (HEAD~1)
writeFileSync(
  join(srcDir, "commands.ts"),
  `export type Command =
  | { type: "ExportCsv"; destination: string }
  | { type: "ExportJson"; destination: string };
`
);

writeFileSync(
  join(srcDir, "router.ts"),
  `import { Command } from "./commands.js";

export function handleCommand(cmd: Command): { success: boolean; message: string } {
  switch (cmd.type) {
    case "ExportCsv":
      return { success: true, message: \`Exporting CSV to \${cmd.destination}\` };
    case "ExportJson":
      return { success: true, message: \`Exporting JSON to \${cmd.destination}\` };
  }
}
`
);

writeFileSync(
  join(srcDir, "utils.ts"),
  `export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
`
);

git("git add -A");
git('git -c user.name="Bench" -c user.email="bench@example.com" commit -m "feat: initial commands router and utils"');

// 2. Patch commit (HEAD) with unhandled router case + redundant clone helper
writeFileSync(
  join(srcDir, "commands.ts"),
  `export type Command =
  | { type: "ExportCsv"; destination: string }
  | { type: "ExportJson"; destination: string }
  | { type: "ExportReport"; destination: string; format: "pdf" | "html" };
`
);

writeFileSync(
  join(srcDir, "utils.ts"),
  `export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export function shallowOrDeepCopy<T>(val: T): T {
  return JSON.parse(JSON.stringify(val));
}
`
);

git("git add -A");
git('git -c user.name="Bench" -c user.email="bench@example.com" commit -m "feat: add ExportReport command and copy helper"');
