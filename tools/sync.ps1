#Requires -Version 5.1
param(
  [string]$HarnessRoot,
  [string]$AgentsRoot,
  [string]$AgentDir,
  [string]$RepoRoot,
  [switch]$Promote,
  [switch]$Deploy,
  [switch]$Prune,
  [switch]$Confirm,
  [switch]$Force,
  [string]$Only,
  [switch]$Quiet
)

$syncMjs = Join-Path $PSScriptRoot 'sync.mjs'
if (-not (Test-Path $syncMjs) -and $HarnessRoot) {
  # The installed copy lives at <harness>\tools\; the repo copy at <repo>\tools\.
  # Never a literal machine path here — this file ships to other hosts.
  $cand = Join-Path $HarnessRoot 'workflow-repo\tools\sync.mjs'
  if (Test-Path $cand) { $syncMjs = $cand }
}
if (-not (Test-Path $syncMjs)) {
  Write-Error "sync.ps1: sync.mjs not found next to this script ($PSScriptRoot) and no -HarnessRoot fallback resolved."
  exit 2
}

if (-not $RepoRoot) {
  $candidates = @((Split-Path -Parent $PSScriptRoot))
  if ($HarnessRoot) { $candidates += (Join-Path $HarnessRoot 'workflow-repo') }
  foreach ($c in $candidates) {
    if ($c -and (Test-Path (Join-Path $c 'install.ps1')) -and (Test-Path (Join-Path $c 'agent\models.yml.example'))) {
      $RepoRoot = $c
      break
    }
  }
}

$argsList = @($syncMjs)
if ($RepoRoot) { $argsList += @('--repo', $RepoRoot) }
if ($HarnessRoot) { $argsList += @('--harness', $HarnessRoot) }
if ($AgentsRoot) { $argsList += @('--agents-root', $AgentsRoot) }
if ($AgentDir) { $argsList += @('--agent-dir', $AgentDir) }
if ($Promote) { $argsList += '--promote' }
if ($Deploy) { $argsList += '--deploy' }
if ($Prune) { $argsList += '--prune' }
if ($Confirm) { $argsList += '--confirm' }
if ($Force) { $argsList += '--force' }
if ($Only) { $argsList += @('--only', $Only) }
if ($Quiet) { $argsList += '--quiet' }

& node @argsList
exit $LASTEXITCODE
