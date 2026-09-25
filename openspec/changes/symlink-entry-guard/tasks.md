# Delivery tasks

- [x] R43: replaced the string-comparison entry guard with a `realpathSync`
  identity check in all 22 guarded `tools/*.mjs`; removed the now-redundant
  filename-suffix fallbacks; left the four intentionally-unconditional tools
  untouched. Verified through an NTFS junction.
- [x] R45: added `tools/tests/symlink-entry.test.mjs`, which links to the repo
  and asserts guarded CLIs still print output through the link; it skips cleanly
  where the OS refuses link creation. Falsified against the pre-fix guard.
- [x] R46: removed the `process.exit()` truncation from every output-writing CLI;
  `install-harness --dry-run --json` (57,901 bytes) parses, and exit codes are
  unchanged (pass 0, fail 1, bad input 2).
- [x] R47: the doctor's shell-based `omp` spawns now build a quoted command
  string, so no `DEP0190` reaches stderr; `install.ps1` no longer aborts and
  `paseo-install.test.mjs` passes `10/10` (was `8/2`).
- [ ] R44: full suite `391/391`, verify `29/29`, audit `15/15`, size gate PASS
  and OpenSpec validation all confirmed locally; push and confirm the
  three-platform CI matrix is green.
