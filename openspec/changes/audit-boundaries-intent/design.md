# Design — close existing seams, do not add new layers

## Sync boundaries

Use the manifest's declared repo/live roots as trust boundaries. Before reading or writing an entry, inspect each existing path component with `lstat` (including a dangling file symlink), resolve it against its declared root, and reject out-of-root or unresolved links. For missing children, check their nearest existing ancestor and planned target; do not mistake a dangling link for a missing child. Preflight every affected entry, including the OMP law copy, before the first deploy/promote write so a late unsafe entry cannot leave partial updates. Keep `--check` read-only and fail nonzero on unsafe input. Preserve normal in-root links when their real paths remain inside the declared root. Extend only the harness-root matcher boundary to treat CR/LF like other delimiters; do not replace arbitrary substrings.

`verify` already resolves `userHome` and its `agentDir`; forward both to `sync` (environment for POSIX, PowerShell arguments or environment on Windows) rather than re-deriving the operator's home. No new config knob.

## Workflow evidence

Use one internal oracle-evidence filename predicate for local and CI scanning. A positive verdict must come from a matching file inside the registered OpenSpec change; an explicit `--path` outside that scope cannot satisfy acceptance or hide a sibling REJECT. Parse both plain and conventional Markdown-bold `Verdict:` labels with negative precedence, without accepting prose mentions. For guarded auto, discover Git membership from the actual worktree, including subdirectories; failed status/diff inspection is an error, never `autoSkipReason`. Parse NUL-delimited porcelain paths so Git's C quoting cannot turn an untracked read/count into zero; refuse a read failure. Keep paths and allow-list measurements relative to the selected project root. Preserve genuinely non-Git behavior.

## Dashboard

Pass the existing `sanitizeHttpState` projection to the static HTML generator. Count newline bytes for untracked diff metadata with one fixed-size read buffer, closing the descriptor on errors. Preserve the existing line-count convention and response text without buffering the whole file. Remove only the byte-identical nested CRO `SKILL.md`; keep its non-identical resources.

## Intent analysis

The linked video's `intent.md` is a pre-spec intake artifact with human correction and Git ownership, not a substitute for our Wave 0 user interview or verbatim requirements manifest. A future optional `intent/` pilot for asynchronous cross-role ideas is a recommendation only; no prompt, skill, template, or CI contract changes in this bugfix.
