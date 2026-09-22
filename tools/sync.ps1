#Requires -Version 5.1
<#
.SYNOPSIS
  Sync the live OMP harness with the distributable workflow repo (drift control).

.DESCRIPTION
  Eliminates configuration drift between the two copies of the harness:

    HarnessRoot (default ~/omp-workflow)  <- live install, read by OMP
    workflow-repo (this repo)            <- git-tracked distributable

  Direction:
    -Promote   HarnessRoot -> workflow-repo   (capture local work into git)
    -Deploy    workflow-repo -> HarnessRoot   (push repo state to the install)
    -Prune     list harness files absent from the repo; delete only with -Confirm
    (default: -Check, report-only, exits 1 on drift)

  Line endings are normalised to LF before comparison, because Windows editors
  rewrite CRLF and would otherwise report every file as divergent.

.EXAMPLE
  powershell -File sync.ps1                  # report drift
  powershell -File sync.ps1 -Promote         # live -> repo
  powershell -File sync.ps1 -Deploy          # repo -> live
  powershell -File sync.ps1 -Prune           # dry-run: what is not in the repo
  powershell -File sync.ps1 -Prune -Confirm  # actually delete those files
#>
param(
  [string]$HarnessRoot = (Join-Path $HOME 'omp-workflow'),
  [string]$AgentsRoot  = (Join-Path $HOME '.agents'),
  [switch]$Promote,
  [switch]$Deploy,
  [switch]$Prune,
  [switch]$Confirm,
  [switch]$Force,
  [string]$Only = '',
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

# Resolve the distributable repo root regardless of which copy of this script is
# invoked: the repo copy lives at <repo>\tools\, the installed copy at
# <harness>\tools\. A marker unique to the REPO is required — agent/ exists in
# both trees, so orchestrator.md alone would wrongly select the harness.
function Resolve-RepoRoot {
  $candidates = @(
    (Split-Path -Parent $PSScriptRoot),
    (Join-Path $HarnessRoot 'workflow-repo')
  )
  foreach ($c in $candidates) {
    if (-not $c) { continue }
    if ((Test-Path (Join-Path $c 'install.ps1')) -and (Test-Path (Join-Path $c 'agent\models.yml.example'))) { return $c }
  }
  throw "Cannot locate workflow-repo (needs install.ps1 + agent\models.yml.example). Pass -HarnessRoot or run from the repo's tools\ directory."
}
$RepoRoot = Resolve-RepoRoot

if ($Promote -and $Deploy) { Write-Error "Choose one of -Promote or -Deploy."; exit 2 }
if ($Prune -and ($Promote -or $Deploy)) { Write-Error "Choose one of -Prune, -Promote or -Deploy."; exit 2 }

# Manifest entries: "relative-path<tab>live-root"
# Most files live under the harness root; rules are installed into ~/.agents.
$Manifest = @(
  'agent\AGENTS.md',
  'agent\agents\orchestrator.md',
  'agent\agents\fixer.md',
  'agent\agents\oracle.md',
  'agent\agents\designer.md',
  'agent\agents\explorer.md',
  'agent\agents\reviewer.md',
  'agent\agents\librarian.md',
  'agent\agents\sonic.md',
  "rules\enterprise-directives.md`t$AgentsRoot",
  "skills\architecture-observability\SKILL.md`t$AgentsRoot",
  'tools\codemap.mjs',
  'tools\prompt-lint.mjs',
  'tools\skills-doctor.mjs',
  'tools\glossary.mjs',
  'tools\replay.mjs',
  'tools\workflow.mjs',
  'tools\auto-review.mjs',
  'tools\cache-doctor.mjs',
  'tools\cache-policy.mjs',
  'tools\return-contract.mjs',
  'tools\session_cost.py',
  'tools\context-inbox.mjs',
  'tools\domain-context.mjs',
  'tools\oracle-model.mjs',
  'tools\debt-ledger.mjs',
  'tools\benchmark.mjs',
  'tools\usage-audit.mjs',
  'tools\test-lens.mjs',
  'tools\doctor.mjs',
  'tools\sync-prune.mjs',
  'tools\memory-cadence.mjs',
  'tools\mutation-test.mjs',
  'tools\gherkin-spec.mjs',
  'tools\dashboard.mjs',
  'tools\fix-plugin-windows.cjs',
  'tools\audit.ps1',
  'tools\sync.ps1',
  'core\PORTABLE.md',
  'paseo\profiles.json',
  'paseo\setup-paseo.ps1',
  'templates\design\DESIGN.md',
  'agent\oracle-priority.example.json',
  'agent\plugins.json',
  'templates\design\examples\good\README.md',
  'templates\design\examples\bad\README.md',
  'templates\ci\workflow-gate.yml',
  'templates\workflow\cache-policy.example.json',
  'templates\paseo.json',
  'CONTEXT.md',
  'README.md'
)

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Read-Normalized([string]$Path) {
  if (-not (Test-Path $Path)) { return $null }
  return ([System.IO.File]::ReadAllText($Path, $Utf8NoBom)) -replace "`r`n", "`n"
}

function Write-Normalized([string]$Path, [string]$Text) {
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($Path, $Text, $Utf8NoBom)
}

# ---------- -Prune: files the harness has and the repo does not ----------
# The candidate list comes from tools\sync-prune.mjs - the same module doctor.mjs
# uses for its `orphan-files` check, so the CLI and the diagnostic cannot drift
# apart. Dry-run by default; only -Confirm deletes. Config/session files and
# .prompt-lint/.workflow/.archmap/node_modules/worktrees are out of scope by
# construction (see the module header).
if ($Prune) {
  $pruneScript = Join-Path $PSScriptRoot 'sync-prune.mjs'
  if (-not (Test-Path $pruneScript)) {
    Write-Error "sync-prune.mjs not found next to sync.ps1 ($pruneScript). Deploy tools\sync-prune.mjs first."
    exit 2
  }
  $pruneArgs = @($pruneScript, '--harness', $HarnessRoot, '--repo', $RepoRoot)
  if ($Confirm) { $pruneArgs += '--delete' }
  & node @pruneArgs
  $pruneExit = $LASTEXITCODE
  if ($pruneExit -ne 0) {
    Write-Host "sync: prune failed (exit $pruneExit)" -ForegroundColor Red
    exit $pruneExit
  }
  if (-not $Confirm) {
    Write-Host "sync: dry-run only - nothing was deleted. Re-run with '-Prune -Confirm' to delete." -ForegroundColor Yellow
  }
  exit 0
}

$drift = @()
$checked = 0
$suspect = @()   # repo newer than live: -Promote would destroy newer work

foreach ($entry in $Manifest) {
  $parts = $entry -split "`t", 2
  $rel = $parts[0]
  $liveRoot = if ($parts.Count -gt 1) { $parts[1] } else { $HarnessRoot }
  if ($Only -and $rel -notlike "*$Only*") { continue }
  $livePath = Join-Path $liveRoot $rel
  $repoPath = Join-Path $RepoRoot $rel
  $checked++

  $live = Read-Normalized $livePath
  $repo = Read-Normalized $repoPath
  # Prompt surfaces (agent defs, rules) ship with '<HARNESS>' so an install can
  # live anywhere; the live tree holds the resolved path. Normalise before
  # comparing, using literal .Replace — the regex form expands $&/$1 in the INPUT
  # and would corrupt any script that contains them.
  # Keyed on the manifest entry, not on file content: content cannot distinguish
  # "templates the path" from "documents the path", and tools/ does the latter.
  $isPromptSurface = ($rel -like 'agent\*') -or ($rel -like 'agent/*') -or
                     ($rel -like 'rules\*') -or ($rel -like 'rules/*') -or
                     ($rel -like 'skills\*') -or ($rel -like 'skills/*')
  if ($null -ne $repo -and $isPromptSurface) {
    $repo = $repo.Replace('<HARNESS>', $HarnessRoot.Replace([char]92, [char]47))
  }

  if ($live -eq $repo) { continue }

  $drift += $rel
  if ($Promote) {
    # Promote writes live -> repo. If the repo copy is NEWER than the live copy,
    # that write destroys newer work: collect it and skip (unless -Force).
    $liveTime = (Get-Item -LiteralPath $livePath -ErrorAction SilentlyContinue).LastWriteTimeUtc
    $repoTime = (Get-Item -LiteralPath $repoPath -ErrorAction SilentlyContinue).LastWriteTimeUtc
    if ($repoTime -and $liveTime -and $repoTime -gt $liveTime) {
      $suspect += $rel
      if (-not $Force) { continue }
    }
    # Never write a NULL side over an existing file: a missing source means
    # "nothing to copy", not "erase the destination".
    if ($null -eq $live) { continue }
    Write-Normalized $repoPath $live
    Write-Host "  [->] promote $rel" -ForegroundColor Cyan
  } elseif ($Deploy) {
    if ($null -eq $repo) { continue }
    Write-Normalized $livePath $repo
    Write-Host "  [<-] deploy  $rel" -ForegroundColor Cyan
  } else {
    Write-Host "  [XX] DRIFT   $rel" -ForegroundColor Red
  }
}

Write-Host ""
if ($drift.Count -eq 0) {
  Write-Host "sync: clean ($checked files checked)" -ForegroundColor Green
  exit 0
}

if ($Promote -and $suspect.Count) {
  if (-not $Force) {
    Write-Host "sync: REFUSED - $($suspect.Count) repo file(s) are NEWER than the live tree:" -ForegroundColor Red
    foreach ($x in $suspect) { Write-Host "  $x" -ForegroundColor Red }
    Write-Host ""
    Write-Host "Promoting would overwrite that work with a stale harness. Either:" -ForegroundColor Yellow
    Write-Host "  -Deploy      push the repo (newer) INTO the live tree, or" -ForegroundColor Yellow
    Write-Host "  -Promote -Force   if the live tree really is the intended source" -ForegroundColor Yellow
    exit 2
  } else {
    Write-Host "sync: FORCED - overwrote $($suspect.Count) newer repo file(s) with the live tree:" -ForegroundColor Yellow
    foreach ($x in $suspect) { Write-Host "  $x" -ForegroundColor Yellow }
  }
}

if ($Promote -or $Deploy) {
  Write-Host "sync: $($drift.Count)/$checked files $(if ($Promote) {'promoted to repo'} else {'deployed to harness'})" -ForegroundColor Green
  exit 0
}

Write-Host "sync: $($drift.Count)/$checked files drifted. Run -Promote or -Deploy." -ForegroundColor Yellow
exit 1
