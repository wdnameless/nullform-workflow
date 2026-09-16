#!/usr/bin/env node
/**
 * archmap-demo.mjs — build a small project with real architectural defects, then
 * render the architecture report for it.
 *
 * WHY: the report is only convincing when you can see it act on a problem you
 * recognise. A demo fixture with a planted dependency cycle, a god module and an
 * orphaned file lets you (or a new user) confirm the tool detects the things it
 * claims to detect, without pointing it at a real repository first.
 *
 *   node archmap-demo.mjs --out ./archmap-demo [--open]
 *
 * Creates <out>/ with source in the shape of a small layered service, runs
 * `archmap.mjs scan` twice (with a change in between) so the report has a real
 * delta, and prints where the HTML landed. Nothing is written outside <out>.
 *
 * Exit 0 ok, 2 cannot run. Zero dependencies. Node 18+ / Bun.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
let out = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--out") out = argv[++i];
  else if (argv[i] === "--open") { /* printed path is enough; openers vary by OS */ }
}
out = resolve(out || join(process.cwd(), "archmap-demo"));

if (process.argv.includes("--help")) {
  console.log("archmap-demo.mjs — build a fixture with known defects and render its report\n");
  console.log("  node archmap-demo.mjs --out ./archmap-demo");
  process.exit(0);
}

/* ------------------------------------------------------------------- fixture */

const FILES = {
  "src/shared/money.ts": `export class Money {
  static of(n: number) { return new Money(n); }
  constructor(public readonly v: number) {}
}
export type Currency = "USD" | "EUR";
`,
  "src/shared/logger.ts": `export function log(m: string) { console.log(m); }
`,
  "src/domain/customer.ts": `import { Money } from "../shared/money";
export interface Customer { id: string; credit: Money; }
`,
  "src/domain/order.ts": `import { Money } from "../shared/money";
import { Customer } from "./customer";
export interface Order { id: string; total: Money; buyer: Customer; }
export class OrderRepository {}
`,

  // A REAL cycle: these two files need each other, so neither can change alone.
  "src/services/pricing.ts": `import { Money } from "../shared/money";
import { applyPromo } from "../api/promo";
export function priceOrder(base: number) { return applyPromo(Money.of(base).v); }
export class PricingEngine {}
`,
  "src/api/promo.ts": `import { priceOrder } from "../services/pricing";
export function applyPromo(v: number) { return priceOrder(v); }
`,

  "src/shared/legacy.ts": `export function oldThing() { return 42; }
`,
  "src/api/routes.ts": `import { render1 } from "../ui/view1";
import { priceOrder } from "../services/pricing";
export function register() { return [render1, priceOrder]; }
`,
};

// The god module: 600+ lines, imported by everything, complexity in the
// hundreds. Generated rather than pasted so the file stays readable here.
function godModule() {
  const head = "export const base = 0;\n";
  const body = [];
  for (let i = 0; i < 600; i++) {
    body.push(
      `export function util${i}(x: number) { if (x > ${i}) { for (let j = 0; j < x; j++) { if (j % 2) return j; } } return x; }\n`,
    );
  }
  return head + body.join("");
}

// Nine services and five views, all importing the god module, so fan-in is high.
function services() {
  const out = {};
  for (let i = 1; i <= 9; i++) {
    out[`src/services/svc${i}.ts`] = `import { util1, util2 } from "../shared/utils";
import { Money } from "../shared/money";
import { Order } from "../domain/order";
export function handle${i}(o: Order) { return util1(o.total.v) + util2(1) + Money.of(0).v; }
`;
  }
  for (let i = 1; i <= 5; i++) {
    out[`src/ui/view${i}.ts`] = `import { handle1 } from "../services/svc1";
import { util1 } from "../shared/utils";
export function render${i}() { return handle1({} as never) + util1(2); }
`;
  }
  return out;
}

/* --------------------------------------------------------------------- write */

if (existsSync(out) && process.argv.includes("--force")) rmSync(out, { recursive: true, force: true });
if (existsSync(join(out, "src"))) {
  console.error(`archmap-demo: ${out} already contains a src/ — pass --force to replace it.`);
  process.exit(2);
}

mkdirSync(join(out, "src"), { recursive: true });
const all = { ...FILES, ...services(), "src/shared/utils.ts": godModule() };
for (const [rel, body] of Object.entries(all)) {
  const p = join(out, ...rel.split("/"));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body, "utf8");
}
const count = Object.keys(all).length;

/* ---------------------------------------------------------------------- scan */

const archmap = join(HERE, "archmap.mjs");
if (!existsSync(archmap)) { console.error(`archmap-demo: cannot find archmap.mjs next to this script`); process.exit(2); }

const run = (label, ...args) => {
  const r = spawnSync(process.execPath, [archmap, ...args], { encoding: "utf8" });
  if (r.status !== 0) { console.error(`archmap-demo: ${label} failed\n${r.stdout}${r.stderr}`); process.exit(2); }
  return (r.stdout || "").trim();
};

console.log(`archmap-demo: wrote ${count} files to ${out}\n`);
console.log("first scan (establishes the baseline):");
console.log("  " + run("first scan", "scan", "--root", out).split("\n").join("\n  "));

// Introduce a change so the report's "What changed" section has real content,
// then scan again. A first-scan report cannot show a delta.
writeFileSync(join(out, "src", "services", "notify.ts"),
  `import { util1 } from "../shared/utils";
import { log } from "../shared/logger";
export function notify(x: number) { log("n"); return util1(x); }
`, "utf8");
const utilsPath = join(out, "src", "shared", "utils.ts");
writeFileSync(utilsPath, readFileSync(utilsPath, "utf8") +
  Array.from({ length: 90 }, (_, i) => `export function extra${i}() { return ${i}; }\n`).join(""), "utf8");

console.log("\nsecond scan (after an added file and a grown module):");
console.log("  " + run("second scan", "scan", "--root", out).split("\n").join("\n  "));

console.log(`\nreport: ${join(out, ".archmap", "architecture.html")}`);
console.log("open it in a browser. It should show:");
console.log("  - a HIGH finding: a 2-file dependency cycle (promo.ts <-> pricing.ts), red in the graph");
console.log("  - a HIGH finding: a 600+ line module imported by many files, amber in the graph");
console.log("  - a delta: +1 file, +90 lines on shared/utils.ts");
console.log("  - an orphan: shared/legacy.ts, which nothing imports");
