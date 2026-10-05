#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const root = process.cwd();
const srcDir = join(root, "src");
mkdirSync(srcDir, { recursive: true });

function git(cmd) {
  execSync(cmd, { cwd: root, stdio: "ignore" });
}

// Write manifest.md (blind acceptance contract)
writeFileSync(
  join(root, "manifest.md"),
  `# Constructed Requirements Manifest (synthetic scenario, not production user evidence)

| ID | Synthetic instruction | Accepted requirement | Status |
|---|---|---|---|
| R01 | "Output hello on command" | CLI prints hello world on stdout | done |
| R02 | "Exit zero on success" | Process exits with status code 0 | done |
`
);

writeFileSync(
  join(srcDir, "cli.mjs"),
  `#!/usr/bin/env node
console.log("hello world");
process.exit(0);
`
);

git("git add -A");
git('git -c user.name="Bench" -c user.email="bench@example.com" commit -m "feat: complete milestone implementation"');
