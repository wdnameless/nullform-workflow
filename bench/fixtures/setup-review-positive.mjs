#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const root = process.cwd();
const srcDir = join(root, "src");
mkdirSync(srcDir, { recursive: true });
writeFileSync(join(root, "manifest.md"), "# Constructed fixture requirements (synthetic scenario, not production user evidence)\n\nR01: Added pipeline events remain actionable through the receiving dispatcher.\nR02: Existing start/stop behavior remains intact.\nR03: Prefer native padding without losing edge-case correctness.\n");

function git(cmd) {
  execSync(cmd, { cwd: root, stdio: "ignore" });
}

// 1. Initial commit (HEAD~1)
writeFileSync(
  join(srcDir, "events.ts"),
  `export type PipelineEvent =
  | { kind: "start"; timestamp: number }
  | { kind: "stop"; timestamp: number };
`
);

writeFileSync(
  join(srcDir, "dispatcher.ts"),
  `import { PipelineEvent } from "./events.js";

export function dispatchEvent(event: PipelineEvent): string {
  switch (event.kind) {
    case "start":
      return "Started pipeline";
    case "stop":
      return "Stopped pipeline";
  }
}
`
);

writeFileSync(
  join(srcDir, "utils.ts"),
  `export function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString();
}
`
);

git("git add -A");
git('git -c user.name="Bench" -c user.email="bench@example.com" commit -m "feat: initial pipeline events and dispatcher"');

// 2. Head commit (HEAD) with cross-boundary defect + redundant helper
writeFileSync(
  join(srcDir, "events.ts"),
  `export type PipelineEvent =
  | { kind: "start"; timestamp: number }
  | { kind: "stop"; timestamp: number }
  | { kind: "pause"; timestamp: number; reason: string };
`
);

writeFileSync(
  join(srcDir, "utils.ts"),
  `export function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString();
}

export function customPad(str: string, len: number, char: string = " "): string {
  let res = str;
  while (res.length < len) {
    res = char + res;
  }
  return res;
}
`
);

git("git add -A");
git('git -c user.name="Bench" -c user.email="bench@example.com" commit -m "feat: add pause event and custom pad helper"');
