#!/usr/bin/env node
/**
 * archmap-demo.mjs — build a small project with real architectural defects, then
 * run archmap over it so a human can see what the report looks like on a codebase
 * they didn't write.
 *
 * It creates a realistic set of modules with:
 *   - real nested, arrow, class, method, constructor calls
 *   - unresolved calls (external node:fs/npm, dynamic bracket calls, unresolved id)
 *   - a REAL circular dependency: promo.ts <-> pricing.ts
 *   - a god module: shared/utils.ts (600+ lines, high fan-in)
 *   - an orphan: shared/legacy.ts (zero callers, zero callees)
 *   - a thin pass-through wrapper
 *   - two scans to demonstrate the "what changed" delta
 *
 * Usage:
 *   node tools/archmap-demo.mjs [--out <dir>] [--force]
 *
 * Defaults to writing to a temporary directory in the cwd.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
let out = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--out" && argv[i + 1]) { out = argv[i + 1]; i++; }
  else if (!argv[i].startsWith("--")) { out = argv[i]; }
}
out = resolve(out || join(process.cwd(), "archmap-demo"));

if (process.argv.includes("--help")) {
  console.log("Usage: node archmap-demo.mjs [--out <dir>] [--force]");
  process.exit(0);
}

/* ------------------------------------------------------------------- fixture */

const FILES = {
  "tsconfig.json": `{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "allowJs": true,
    "skipLibCheck": true
  }
}`,

  "src/shared/money.ts": `export class Money {
  static of(n: number): Money { return new Money(n); }
  constructor(public readonly v: number) {}
  format(): string { return "$" + this.v.toFixed(2); }
}
export type Currency = "USD" | "EUR";
`,

  "src/shared/logger.ts": `import * as fs from "node:fs";

export function log(m: string): void {
  // External runtime call
  console.log("[LOG]", m);
  // Another external call
  process.stdout.write(m + "\\n");
}

export const formatMessage = (prefix: string, body: string) => {
  return prefix + ": " + body;
};
`,

  "src/domain/customer.ts": `import { Money } from "../shared/money";
import { log } from "../shared/logger";

export interface Customer { id: string; credit: Money; }

export class CustomerService {
  findCustomer(id: string): Customer {
    log("Finding customer: " + id);
    return { id, credit: Money.of(100) };
  }
}
`,

  "src/domain/order.ts": `import { Money } from "../shared/money";
import { Customer, CustomerService } from "./customer";

export interface Order { id: string; total: Money; buyer: Customer; }

export class OrderRepository {
  private customerService = new CustomerService();

  createOrder(customerId: string, amount: number): Order {
    const customer = this.customerService.findCustomer(customerId);
    const money = Money.of(amount);
    return { id: "ord_1", total: money, buyer: customer };
  }
}
`,

  // A REAL cycle: these two files need each other, so neither can change alone.
  "src/services/pricing.ts": `import { Money } from "../shared/money";
import { applyPromo } from "../api/promo";
import { log } from "../shared/logger";

export function priceOrder(base: number): number {
  log("Calculating price: " + base);
  const money = Money.of(base);
  return applyPromo(money.v);
}

export class PricingEngine {
  calculate(base: number): number {
    return priceOrder(base);
  }
}
`,

  "src/api/promo.ts": `import { priceOrder } from "../services/pricing";

export function applyPromo(v: number): number {
  if (v > 100) {
    return v * 0.9;
  }
  return priceOrder(v + 10);
}
`,

  "src/shared/legacy.ts": `export function oldThing() { return 42; }
`,

  "src/api/routes.ts": `import { render1 } from "../ui/view1";
import { priceOrder } from "../services/pricing";
import { log } from "../shared/logger";

export class ApiRouter {
  handleRequest(action: string, param: any) {
    log("Handling route action: " + action);

    // Static call to imported function
    const price = priceOrder(100);

    // Dynamic call: bracket access on object
    const handlers: Record<string, Function> = {
      view: render1
    };
    if (handlers[action]) {
      handlers[action]();
    }

    // Unresolved call: calling missing / external function
    if (typeof nonExistentGlobalTracker === "function") {
      // @ts-ignore
      nonExistentGlobalTracker(action);
    }

    return price;
  }
}

export function register() {
  const router = new ApiRouter();
  return router.handleRequest("view", 42);
}
`,
};

// The god module: 600+ lines, imported by everything, complexity in the
// hundreds. Generated rather than pasted so the file stays readable here.
function godModule() {
  const parts = [
    `// God module: too many lines, too many branches, imported everywhere.`,
    `import { log } from "./logger";`,
    `import { Money } from "./money";`,
  ];
  for (let i = 0; i < 70; i++) {
    parts.push(`export function util${i}(x: number) {
  log("util " + ${i});
  const m = Money.of(x);
  if (x > 10) return m.v + ${i};
  else if (x > 5) return m.v - ${i};
  else if (x === 0) return 0;
  return ${i};
}`);
  }
  return parts.join("\n\n");
}

// Nine services and five views, all importing the god module, so fan-in is high.
function services() {
  const out = {};
  for (let i = 1; i <= 9; i++) {
    out[`src/services/service${i}.ts`] = `import { util${i} } from "../shared/utils";
import { log } from "../shared/logger";

export function run${i}(n: number) {
  log("Service ${i} running");
  return util${i}(n);
}
`;
  }
  for (let i = 1; i <= 5; i++) {
    out[`src/ui/view${i}.ts`] = `import { util${i} } from "../shared/utils";
export function render${i}() {
  return "view " + util${i}(${i});
}
`;
  }
  return out;
}

/* --------------------------------------------------------------------- write */

if (existsSync(out) && process.argv.includes("--force")) rmSync(out, { recursive: true, force: true });
if (existsSync(join(out, "src"))) {
  console.error(`archmap-demo: ${out} already exists. Pass --force to overwrite.`);
  process.exit(2);
}

mkdirSync(join(out, "src"), { recursive: true });
const all = { ...FILES, ...services(), "src/shared/utils.ts": godModule() };
for (const [rel, body] of Object.entries(all)) {
  const target = join(out, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body, "utf8");
}
const count = Object.keys(all).length;

/* ---------------------------------------------------------------------- scan */

const archmap = join(HERE, "archmap.mjs");
if (!existsSync(archmap)) { console.error(`archmap-demo: cannot find archmap.mjs next to this script`); process.exit(2); }

const run = (label, ...args) => {
  const res = spawnSync("node", [archmap, ...args], { encoding: "utf8" });
  if (res.status !== 0) {
    console.error(`archmap-demo: ${label} failed:`);
    console.error(res.stderr || res.stdout);
    process.exit(2);
  }
  return res.stdout.trim();
};

console.log(`archmap-demo: wrote ${count} files to ${out}\n`);
console.log("first scan (establishes the baseline):");
console.log("  " + run("first scan", "scan", "--root", out).split("\n").join("\n  "));

// Introduce a change so the report's "What changed" section has real content,
// then scan again. A first-scan report cannot show a delta.
writeFileSync(join(out, "src", "services", "notify.ts"),
  `import { util1 } from "../shared/utils";
export function notify(user: string) { return util1(10); }
`, "utf8");
const utilsPath = join(out, "src", "shared", "utils.ts");
writeFileSync(utilsPath, readFileSync(utilsPath, "utf8") +
  Array.from({ length: 90 }, (_, i) => `\nexport function extra${i}() { return ${i}; }`).join(""), "utf8");

console.log("\nsecond scan (after an added file and a grown module):");
console.log("  " + run("second scan", "scan", "--root", out).split("\n").join("\n  "));

console.log(`\nreport: ${join(out, ".archmap", "architecture.html")}`);
console.log("open it in a browser. It should show:");
console.log("  - a HIGH finding: a 2-file dependency cycle (promo.ts <-> pricing.ts), red in the graph");
console.log("  - a HIGH finding: a 600+ line module imported by many files, amber in the graph");
console.log("  - semantic symbols and static calls between functions, methods, constructors");
console.log("  - unresolved / dynamic calls tracked (e.g. ApiRouter handlers[action] dynamic, console.log external)");
console.log("  - a delta: +1 file, +90 lines on shared/utils.ts");
console.log("  - an orphan: shared/legacy.ts, which nothing imports");
