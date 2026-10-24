import test from "node:test";
import assert from "node:assert/strict";

import { safeForTerminal, hasTerminalEscapes } from "../sanitize-text.mjs";

// Measured before this module: a SKILL.md frontmatter name containing an escape reached
// stdout as a live colour change. The skill text is attacker-controlled; our terminal is not.

test("colour and cursor sequences are removed", () => {
  assert.equal(safeForTerminal("\u001b[31mRED\u001b[0m"), "RED");
  assert.equal(safeForTerminal("\u001b[2Jcleared"), "cleared");
  assert.equal(safeForTerminal("a\u001b[1;2Hb"), "ab");
});

test("OSC title and hyperlink sequences are removed whole", () => {
  assert.equal(safeForTerminal("\u001b]0;owned\u0007visible"), "visible");
  assert.equal(safeForTerminal("\u001b]8;;http://x\u001b\\link\u001b]8;;\u001b\\"), "link");
});

test("C1 and raw control characters are removed but tab and newline survive", () => {
  assert.equal(safeForTerminal("\u009b31mx"), "31mx");
  assert.equal(safeForTerminal("a\u0007b"), "ab");
  assert.equal(safeForTerminal("line1\nline2\tcol"), "line1\nline2\tcol", "structure is not an attack");
});

test("ordinary text is returned unchanged", () => {
  for (const s of ["plain", "emoji 🎯", "кириллица", "a-b_c.d", ""]) assert.equal(safeForTerminal(s), s);
  assert.equal(safeForTerminal(null), "");
  assert.equal(safeForTerminal(undefined), "");
});

test("hasTerminalEscapes reports rather than silently cleaning", () => {
  assert.equal(hasTerminalEscapes("\u001b[31mred"), true);
  assert.equal(hasTerminalEscapes("clean"), false);
  assert.equal(hasTerminalEscapes(""), false);
  assert.equal(hasTerminalEscapes(null), false);
});
