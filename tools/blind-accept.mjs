import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Runs blind acceptance in an isolated temporary git clone.
 * Forbidden spec/manifest/ticket paths are deleted before running acceptance.
 *
 * @param {string} repoDir - Path to source git repository
 * @param {string} briefText - Raw brief content
 * @param {(cloneDir: string, briefText: string) => Promise<{ checked: number, matched: number, mismatches: any[] }> | { checked: number, matched: number, mismatches: any[] }} runner
 * @returns {Promise<{ checked: number, matched: number, mismatches: any[] }>}
 */
export async function blindAccept(repoDir, briefText, runner) {
  if (!repoDir || typeof repoDir !== "string") {
    throw new Error("blindAccept: repoDir must be a non-empty string path");
  }
  if (typeof runner !== "function") {
    throw new Error("blindAccept: runner must be a function");
  }

  const cloneDir = mkdtempSync(join(tmpdir(), "ap-blind-accept-"));

  try {
    const cloneRes = spawnSync("git", ["clone", repoDir, cloneDir], {
      stdio: "pipe",
      encoding: "utf8",
    });

    if (cloneRes.status !== 0) {
      throw new Error(
        `git clone failed with code ${cloneRes.status}: ${cloneRes.stderr || cloneRes.stdout}`
      );
    }

    // Delete spec/manifest/ticket paths inside the clone
    for (const forbiddenPath of findForbidden(cloneDir)) {
      rmSync(forbiddenPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }

    // Verify none survive (throw otherwise)
    const surviving = findForbidden(cloneDir);
    if (surviving.length > 0) {
      throw new Error(
        `Forbidden paths survived blind acceptance purge: ${surviving.join(", ")}`
      );
    }

    // Run runner(cloneDir, briefText)
    const runRes = await Promise.resolve(runner(cloneDir, briefText));

    return {
      checked: typeof runRes?.checked === "number" ? runRes.checked : 0,
      matched: typeof runRes?.matched === "number" ? runRes.matched : 0,
      mismatches: Array.isArray(runRes?.mismatches) ? runRes.mismatches : [],
    };
  } finally {
    try {
      rmSync(cloneDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (_) {}
  }
}

function findForbidden(dir) {
  const matches = [];
  if (!existsSync(dir)) return matches;
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const full = join(dir, entry.name);
    const lower = entry.name.toLowerCase();

    if (entry.isDirectory()) {
      if (lower === "openspec" || lower === "tickets") {
        matches.push(full);
      } else {
        matches.push(...findForbidden(full));
      }
    } else if (entry.isFile() && (lower === "spec.md" || lower === "manifest.md")) {
      matches.push(full);
    }
  }

  return matches;
}
