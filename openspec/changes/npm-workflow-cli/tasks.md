# Tasks: npm-workflow-cli

- [x] A PackageCli: npm package/bin, interactive and headless init, persisted identity, registry-based check/update. R01/R02/R05/R06/R07. blocked-by: none.
- [x] B HarnessAdapters: selected native paths/config/skills, safe preservation/preflight and selected doctor checks. R03/R04/R05. blocked-by: none.
- [x] C PackageProof: real npm tarball/global-prefix/local-registry smoke, focused boundary checks and README/glossary updates. R01-R08. blocked-by: none for authoring; execution blocked-by: A,B.
- [x] Parent: reconcile contracts; package smoke and complete existing test suite, package inclusion/secrets checks. blocked-by: A,B,C. Evidence: complete suite 687 passed, 0 failed; actual npm smoke R01-R08; PTY select OpenCode and cancel without root/state writes; size/debt gates pass.
- [x] Parent: native reviewer, frozen Stage-A and one Stage-B iteration; blind oracle(s) against manifest and smoke command. Evidence: native reviewer ACCEPT, lean-already with frozen command exit 0, two distinct native oracle sessions ACCEPT and actual R01-R08 execution.
- [x] Parent: deliver tarball and exercised commands, close honestly; no public publishing. Verified archive: .tmp/nullform-workflow-1.1.0.tgz; publication excluded by explicit user selection.
