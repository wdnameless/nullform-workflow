/**
 * tools/sanitize-text.mjs — strip terminal escape sequences from untrusted strings.
 *
 * Why: a SKILL.md frontmatter `name` is attacker-controlled text that our tools print to
 * a terminal. Measured before this module existed: `name: "\u001b[31mRED\u001b[0m"`
 * reached stdout as a live colour change (`^[[31mRED^[[0m`). A malicious skill can clear
 * the screen, move the cursor back over a previous line, or repaint our own output to
 * look like a different result — CWE-150, "terminal escape injection".
 *
 * Credit where due: the sequence coverage here is the same set Vercel's `skills` CLI
 * ships in `src/sanitize.ts` (CSI/OSC/DCS/C1/simple-ESC). What is ours is the policy:
 * sanitize at the print boundary for untrusted input only, never mutate stored data.
 *
 * Usage:
 *   const shown = safeForTerminal(untrusted);
 *   console.log(`  ${shown}`);
 *
 * Do NOT use on trusted, already-controlled output: colours we emit deliberately would
 * be stripped. The point is a boundary, not a global style.
 */

// CSI: ESC [ params intermediates final
const CSI_RE = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g;
// OSC: ESC ] ... terminated by BEL or ST
const OSC_RE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
// DCS / PM / APC: ESC P|^|_ ... ST
const DCS_PM_APC_RE = /\x1b[P^_][\s\S]*?(?:\x1b\\)/g;
// Two-byte escapes: ESC followed by one printable char
const SIMPLE_ESC_RE = /\x1b[\x20-\x7e]/g;
// C1 control codes (8-bit ESC equivalents)
const C1_RE = /[\x80-\x9f]/g;
// Raw controls except tab and newline (BEL, BS, CR, DEL, ...)
const CONTROL_RE = /[\x00-\x06\x07\x08\x0b\x0c\x0d-\x1a\x1c-\x1f\x7f]/g;

/** Strip escape sequences and dangerous control characters from untrusted text. */
export function safeForTerminal(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(OSC_RE, "")
    .replace(DCS_PM_APC_RE, "")
    .replace(CSI_RE, "")
    .replace(SIMPLE_ESC_RE, "")
    .replace(C1_RE, "")
    .replace(CONTROL_RE, "");
}

/** True when the string carries something `safeForTerminal` would remove.
 * Tools can report "this name contained control characters" instead of silently cleaning. */
export function hasTerminalEscapes(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  return safeForTerminal(value) !== value;
}
