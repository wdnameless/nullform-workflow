#!/usr/bin/env node
// Bounded maintenance consumer: extend an already-working order-summary module
// with refund handling, preserving its public positive-order behavior.
//
// Deterministic control implementations (valid + deliberately broken) exercise the
// checker without any model dispatch. No native transcript is required because the
// checks are self-contained Node modules, not model output.
//
// Safety: git is invoked with an explicit argument array and a GIT_*-free
// environment, and only THIS fixture's manifest.md + src/order-summary.mjs are
// staged/committed. Ambient GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE cannot redirect
// this fixture's writes outside its consumer cwd.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(process.cwd());
const srcDir = join(root, "src");
const manifestPath = join(root, "manifest.md");
const modulePath = join(srcDir, "order-summary.mjs");

function gitEnv() {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))),
    GIT_TERMINAL_PROMPT: "0",
  };
}

function git(args) {
  return spawnSync("git", args, { cwd: root, env: gitEnv(), encoding: "utf8" });
}

// Prove the ambient git environment is not redirecting this root before any write.
const gitDir = git(["rev-parse", "--absolute-git-dir"]);
if (gitDir.status !== 0) throw new Error(`not a git repository: ${root} (${gitDir.stderr.trim()})`);
const toplevel = git(["rev-parse", "--show-toplevel"]);
if (toplevel.status !== 0) throw new Error(`cannot resolve git toplevel for ${root}: ${toplevel.stderr.trim()}`);
if (resolve(toplevel.stdout.trim()) !== root) {
  throw new Error(`refusing to run: git toplevel ${toplevel.stdout.trim()} is not ${root}`);
}
const expectedGitDir = resolve(root, ".git");
if (resolve(gitDir.stdout.trim()) !== expectedGitDir) {
  throw new Error(`refusing to run: git dir ${gitDir.stdout.trim()} is not ${expectedGitDir}`);
}

mkdirSync(srcDir, { recursive: true });

writeFileSync(
  manifestPath,
  "# Constructed fixture requirements (synthetic scenario, not production user evidence)\n\n" +
    "R01: `summarizeOrder(order)` keeps returning the correct public summary for positive orders (items, subtotal, tax, total) when refunds are added to the module.\n" +
    "R02: `applyRefund(order, refund)` returns an updated order with the refund recorded in `order.refunds`; the refund amount is subtracted from `totalCents`; a refund exceeding the remaining total is rejected (never a negative total); refunds apply in order.\n" +
    "R03: Invalid input is rejected: negative item price/quantity, non-integer cents, unknown refund target, refund larger than remaining total, refund amount not a positive integer number of cents. Declared input contract: priceCents is a nonnegative safe integer (zero allowed); quantity is a positive safe integer; refund amount is a positive safe integer; every subtotal/tax/total/refunded/remaining figure is a checked safe integer (no overflow wrap, no negative total).\n" +
    "R04: Declared finite workload for the fixture: a single-pass summarizeOrder over 50000 items (priceCents 100..149 cycling, quantity 1..4 cycling) with exact independent expected subtotal 15575000, tax 3115000, total 18690000 cents; fixture-only 5000ms smoke bound (exceeding it fails the check); actual elapsed time, node version, platform and arch are recorded as raw evidence. This is NOT a universal performance claim.\n" +
    "R05: No real model dispatch; the check validates behavior, not source strings or class names. Measurement limits: the deterministic checker is exercised by hand-written valid/broken controls, not by any model run.\n"
);

// Working baseline: correct positive-order summary, refunds not yet handled.
writeFileSync(
  modulePath,
  `// Working baseline. Positive-order summary is correct and public.
// Refund handling is the requested maintenance change.
export function summarizeOrder(order) {
  if (!order || !Array.isArray(order.items) || order.items.length === 0) {
    throw new Error("invalid order: expected a non-empty items array");
  }
  let subtotalCents = 0;
  for (const item of order.items) {
    assertItem(item);
    subtotalCents += item.priceCents * item.quantity;
  }
  const taxCents = Math.round(subtotalCents * 0.2);
  return { items: order.items.length, subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

function assertItem(item) {
  if (!item || typeof item !== "object") throw new Error("invalid item");
  if (!Number.isInteger(item.priceCents) || item.priceCents < 0) throw new Error("invalid item price");
  if (!Number.isInteger(item.quantity) || item.quantity <= 0) throw new Error("invalid item quantity");
}
`
);

// Stage and commit ONLY this fixture's two files; never `git add -A`.
const staged = git(["add", "--", "manifest.md", "src/order-summary.mjs"]);
if (staged.status !== 0) throw new Error(`bench fixture git add failed: ${staged.stderr.trim()}`);

const status = git(["status", "--porcelain", "--", "manifest.md", "src/order-summary.mjs"]);
if (status.status !== 0) throw new Error(`bench fixture git status failed: ${status.stderr.trim()}`);
if (!status.stdout.trim()) {
  process.exit(0); // idempotent: nothing new to commit in this root
}

const committed = git([
  "-c",
  "user.name=Bench",
  "-c",
  "user.email=bench@example.com",
  "commit",
  "-m",
  "feat: working order summary baseline",
  "--",
  "manifest.md",
  "src/order-summary.mjs",
]);
if (committed.status !== 0) throw new Error(`bench fixture git commit failed: ${committed.stderr.trim()}`);
