import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import { skillFolderHash, verifySkillsLock } from "../carry.mjs";

// `hash` covers SKILL.md only. 45 of our 72 skills ship 476 bundled files, so a swapped
// reference file used to be invisible: the SKILL.md still matched.

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "carry-lock-"));
  const dir = join(root, "skills", "alpha");
  mkdirSync(join(dir, "references"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "---\nname: alpha\n---\nbody\n", "utf8");
  writeFileSync(join(dir, "references", "a.md"), "# A\n", "utf8");
  const sha = createHash("sha256").update(readFileSync(join(dir, "SKILL.md"))).digest("hex");
  return { root, dir, sha };
}

test("folder hash is stable and changes when any bundled file changes", () => {
  const { dir } = fixture();
  try {
    const first = skillFolderHash(dir);
    assert.equal(skillFolderHash(dir), first, "same tree, same digest");
    writeFileSync(join(dir, "references", "a.md"), "# A changed\n", "utf8");
    assert.notEqual(skillFolderHash(dir), first);
  } finally { rmSync(join(dir, "..", ".."), { recursive: true, force: true }); }
});

test("folder hash changes when a file is renamed, not only when it is edited", () => {
  const { dir } = fixture();
  try {
    const before = skillFolderHash(dir);
    writeFileSync(join(dir, "references", "b.md"), "# A\n", "utf8");
    const withCopy = skillFolderHash(dir);
    assert.notEqual(withCopy, before, "an added identical file must still change the digest");
  } finally { rmSync(join(dir, "..", ".."), { recursive: true, force: true }); }
});

test("line endings do not change the digest", () => {
  const { dir } = fixture();
  try {
    const lf = skillFolderHash(dir);
    writeFileSync(join(dir, "references", "a.md"), "# A\r\n", "utf8");
    assert.equal(skillFolderHash(dir), lf, "a Windows checkout and Linux CI must agree");
  } finally { rmSync(join(dir, "..", ".."), { recursive: true, force: true }); }
});

test("verifySkillsLock catches a bundled-file edit that leaves SKILL.md intact", () => {
  const { root, dir, sha } = fixture();
  try {
    const lockPath = join(root, "skills-lock.json");
    writeFileSync(lockPath, JSON.stringify({
      version: 1,
      skills: { alpha: { hash: sha, folderHash: skillFolderHash(dir) } },
    }), "utf8");

    assert.equal(verifySkillsLock(lockPath, root, { throws: false }).ok, true);

    writeFileSync(join(dir, "references", "a.md"), "# tampered\n", "utf8");
    const res = verifySkillsLock(lockPath, root, { throws: false });
    assert.equal(res.ok, false);
    assert.match(res.error, /bundled files changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a lock entry without folderHash still verifies (backward compatible)", () => {
  const { root, sha } = fixture();
  try {
    const lockPath = join(root, "skills-lock.json");
    writeFileSync(lockPath, JSON.stringify({ version: 1, skills: { alpha: { hash: sha } } }), "utf8");
    assert.equal(verifySkillsLock(lockPath, root, { throws: false }).ok, true,
      "an older lock must not start failing because the verifier learned a new field");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
