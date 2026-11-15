// `artifact` recording, extracted from the CLI module so that file stays inside its size
// ceiling and this command keeps one job: validate one artifact, then record it.
//
// Every dependency is injected. The recorder is therefore testable without a live workflow
// root, and the CLI keeps ownership of state locking and of the file-system primitives.
//
// Validation is split by artifact shape (directory vs file vs note-only) so each piece is
// short enough to read at once; the command itself only sequences them.

/** Non-empty regular file. */
const isNonEmptyFile = (path, io) => {
  try {
    return io.existsSync(path) && io.statSync(path).isFile() && io.readFileSync(path, "utf8").trim().length > 0;
  } catch {
    return false;
  }
};

/**
 * Everything an openspec change directory must satisfy before it counts as recorded:
 * inside the project, non-empty, with a proposal and (unless it declares skip_specs) specs.
 * Returns the operator-facing problem, or null when the directory is acceptable.
 */
function openspecDirectoryProblem(root, path, fullPath, deps) {
  const { declaresSkipSpecs, isRealPathInsideRoot, existsSync, statSync, readdirSync, join } = deps;
  if (!statSync(fullPath).isDirectory()) return `${path} -> '${path}' must be a directory.`;
  const entries = readdirSync(fullPath);
  if (entries.length === 0) return `${path} -> directory '${path}' is empty.`;
  for (const entry of entries) {
    const entryPath = join(path, entry);
    if (!isRealPathInsideRoot(root, entryPath)) return `${path} -> entry '${entryPath}' real path must stay inside project root.`;
  }
  if (!isNonEmptyFile(join(fullPath, "proposal.md"), deps)) return `${path} -> missing non-empty proposal.md in '${path}'.`;
  // A change with no spec-level behaviour change declares it instead of fabricating a delta.
  if (declaresSkipSpecs(fullPath)) return null;
  const specsPath = join(fullPath, "specs");
  const hasSpecs = existsSync(specsPath) && statSync(specsPath).isDirectory() && readdirSync(specsPath).length > 0;
  if (!hasSpecs) {
    return `${path} -> missing non-empty specs/ directory in '${path}'. a tooling/docs-only change declares schema: spec-driven + skip_specs: true in ${path}/.openspec.yaml`;
  }
  return null;
}

/**
 * Content rules for a single-file artifact: non-empty, matching its declared pattern, long
 * enough for interfaces, and — for change-scoped kinds — living inside the change directory.
 * Returns the problem, or null.
 */
function artifactFileProblem(root, st, kind, path, req, fullPath, deps) {
  const { changeScopeProblem, readFileSync, statSync } = deps;
  if (!statSync(fullPath).isFile()) return `${kind} -> '${path}' must be a file.`;
  const body = readFileSync(fullPath, "utf8");
  if (body.trim().length === 0) return `${kind} -> '${path}' is empty.`;
  if (req.mustContain && !req.mustContain.test(body)) {
    return `${path} does not contain requirement rows (expected ${req.mustContain}). a manifest lists R01..Rnn, each with the verbatim quote it came from.`;
  }
  if (kind === "interfaces" && body.trim().length < 10) return `${kind} -> '${path}' is too short to be a valid interfaces specification.`;
  // Reject a change-scoped artifact recorded outside the change directory HERE, so the
  // operator gets the reason now instead of a "belongs to another change" surprise at
  // `check`/`close` time after believing the artifact was recorded.
  return changeScopeProblem(root, st, kind, fullPath);
}

/**
 * Free-text note rules: a stated detail of minimum length, an ACCEPT/REJECT outcome when the
 * artifact's contract is a verdict, and acceptance evidence for recon-style notes where the
 * note IS the artifact.
 */
function artifactDetailProblem(req, detail) {
  if (req.minDetail && (!detail || detail.trim().length < req.minDetail)) {
    return `${req.kind} needs a real description (>= ${req.minDetail} chars). got: ${detail ? JSON.stringify(detail) : "(nothing)"} — record it: --detail "<what you actually did/verified>"`;
  }
  // `mustContain` describes the ARTIFACT's file body (e.g. a manifest holds R## rows),
  // never the free-text note. Testing the note rejected valid submissions whenever the
  // operator described the work in prose instead of echoing the pattern.
  const verdictContract = req.mustContain && /ACCEPT|REJECT/i.test(String(req.mustContain));
  if (detail && verdictContract && !req.mustContain.test(detail)) {
    return `${req.kind} must state the outcome — expected ${req.mustContain}. e.g. --detail "ACCEPT: verified X and Y, no gaps"`;
  }
  // For a note whose contract is "acceptance check", the free text IS the artifact: there is
  // no file to test. 39 of 65 historical recon notes listed files and never said how
  // completion would be proven, which is what made the T1 gate decorative.
  if (detail && req.detailMustContain && !req.detailMustContain.test(detail)) {
    return `${req.kind} must name how the work is checked — got no acceptance evidence. e.g. --detail "files a.mjs,b.mjs; acceptance: node --test tools/tests/x.test.mjs passes"`;
  }
  return null;
}

/** Path-shape rules shared by every artifact kind: relative, inside root, existing, real. */
function artifactPathProblem(root, kind, path, deps) {
  const { isPathInsideRoot, isRealPathInsideRoot, existsSync, join } = deps;
  if (!isPathInsideRoot(root, path)) return `${kind} -> '${path}' must be a relative path inside project root.`;
  const fullPath = join(root, path);
  if (!existsSync(fullPath)) {
    const hint = kind === "openspec" ? ` create it: openspec new change <name>   then  openspec validate <name>` : "";
    return `${kind} -> '${path}' does not exist on disk.${hint}`;
  }
  if (!isRealPathInsideRoot(root, path)) return `${kind} -> '${path}' real path must stay inside project root.`;
  return null;
}

/** `--path` is mandatory for kinds whose evidence IS a file; name the flag when it is missing. */
function requiredPathProblem(req, kind, path) {
  return req.requiresPath && !path ? `${kind} requires a file path (--path <file>).` : null;
}

export function cmdArtifact(root, flags, deps) {
  const { withStateLock, load, save, requiredFor, createArtifactRecord, logEvent, join } = deps;
  return withStateLock(root, () => {
    const st = load(root);
    if (!st || st.status !== "open") { console.error("workflow: no open task. Run `start` first."); return 2; }
    const kind = String(flags.kind || "");
    const reqs = requiredFor(st.tier);
    const req = reqs.find((r) => r.kind === kind);
    if (!req) {
      console.error(`workflow: '${kind}' is not required by ${st.tier}.`);
      console.error(`  required: ${reqs.map((r) => r.kind).join(', ')}`);
      return 2;
    }
    const path = flags.path ? String(flags.path).trim() : null;
    const requirementProblem = requiredPathProblem(req, kind, path);
    if (requirementProblem) { console.error(`workflow: ${requirementProblem}`); return 1; }

    if (path) {
      const pathProblem = artifactPathProblem(root, kind, path, deps);
      if (pathProblem) { console.error(`workflow: ${pathProblem}`); return 1; }
      const fullPath = join(root, path);
      const shapeProblem = kind === "openspec"
        ? openspecDirectoryProblem(root, path, fullPath, deps)
        : artifactFileProblem(root, st, kind, path, req, fullPath, deps);
      if (shapeProblem) { console.error(`workflow: ${shapeProblem}`); return 1; }
    }

    const detail = flags.detail ? String(flags.detail) : null;
    const detailProblem = artifactDetailProblem(req, detail);
    if (detailProblem) { console.error(`workflow: ${detailProblem}`); return 1; }

    st.artifacts[kind] = createArtifactRecord(root, st, kind, path, detail);
    save(root, st);
    logEvent(root, "artifact", `${kind}${detail ? ": " + detail.slice(0, 120) : ""}`);
    console.log(`workflow: ${kind} recorded${path ? ` (${path})` : ""} — ${Object.keys(st.artifacts).length}/${reqs.length} for ${st.tier}`);
    return 0;
  });
}
