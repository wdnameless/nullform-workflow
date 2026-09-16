#Requires -Version 5.1
<#
.SYNOPSIS
  One-command harness health audit. Bundles every mechanical check into a single
  report, so a scheduled agent (or a human) gets a verdict without re-deriving
  the commands.

.DESCRIPTION
  Runs, in order:
    1. sync.ps1              harness/repo drift
    2. prompt-lint scan      volatile literals in prompt surfaces
    3. prompt-lint check     prompt-cache prefix stability vs baseline
    4. skills-doctor         registry health (frontmatter/truncation/parity/orphans)
    5. glossary check        public symbols missing from CONTEXT.md
    6. codemap changes       folders needing re-mapping

  Exit 0 = all clean, 1 = at least one finding, 2 = cannot run.

.EXAMPLE
  powershell -File audit.ps1
  powershell -File audit.ps1 -Scope src,lib     # glossary scope for a project
#>
param(
  # Default to the tree this script lives in: it is shipped INTO the harness
  # root by install.ps1, so $PSScriptRoot identifies it without any assumption
  # about where the user installed. -HarnessRoot overrides.
  [string]$HarnessRoot = '',
  # Standalone installs have no repo beside them: default to the harness root
  # itself so the checks still run against a coherent tree.
  [string]$RepoRoot    = '',
  [string[]]$Scope     = @(),
  [switch]$Json
)

$ErrorActionPreference = 'Continue'
if (-not $PSScriptRoot) { $PSScriptRoot = (Get-Location).Path }
if ([string]::IsNullOrWhiteSpace($HarnessRoot)) {
  $HarnessRoot = Split-Path -Parent $PSScriptRoot
  if ([string]::IsNullOrWhiteSpace($HarnessRoot)) { $HarnessRoot = $PSScriptRoot }
}
if ($HarnessRoot) { $HarnessRoot = [System.IO.Path]::GetFullPath($HarnessRoot) }

# Resolve the LIVE harness and the REPO independently. Running this from a repo
# clone must still audit the installed harness, not the clone.
$self = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($self)) { $self = $PSScriptRoot }
if (Test-Path (Join-Path $PSScriptRoot 'agent\AGENTS.md')) { $self = $PSScriptRoot }
if (-not (Test-Path (Join-Path $HarnessRoot 'agent\AGENTS.md'))) {
  if (Test-Path (Join-Path $self 'agent\AGENTS.md')) { $HarnessRoot = [System.IO.Path]::GetFullPath($self) }
}
$harnessIsRepo = Test-Path (Join-Path $HarnessRoot 'install.ps1')
if ($harnessIsRepo) {
  if ([string]::IsNullOrWhiteSpace($RepoRoot)) { $RepoRoot = $HarnessRoot }
} else {
  if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $hParent = Split-Path -Parent $HarnessRoot
    $cands = @()
    if ($hParent) {
      $cands += (Join-Path $hParent 'workflow-repo')
      $cands += (Join-Path $hParent (Split-Path -Leaf $HarnessRoot) + '-repo')
    }
    $hit = $cands | Where-Object { $_ -and (Test-Path (Join-Path $_ 'install.ps1')) } | Select-Object -First 1
    if ($hit) { $RepoRoot = $hit } else { $RepoRoot = $HarnessRoot }
  }
}
if ($RepoRoot) { $RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot) }
if ($HarnessRoot) { $HarnessRoot = [System.IO.Path]::GetFullPath($HarnessRoot) }
$findings = @()
$results  = @()

function Invoke-Check([string]$name, [scriptblock]$body) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $r = & $body
    $sw.Stop()
    $script:results += [pscustomobject]@{
      Check  = $name
      Result = $(if ($r.Ok) { 'PASS' } else { 'FAIL' })
      Detail = $r.Detail
      Ms      = [int]$sw.ElapsedMilliseconds
    }
    if (-not $r.Ok) { $script:findings += $name }
  } catch {
    $sw.Stop()
    $script:results += [pscustomobject]@{ Check = $name; Result = 'FAIL'; Detail = $_.Exception.Message; Ms = [int]$sw.ElapsedMilliseconds }
    $script:findings += $name
  }
}

# Run a node/PowerShell child and capture BOTH exit code and output reliably.
# $LASTEXITCODE is clobbered by intermediate cmdlets, so use Start-Process.
function Invoke-Capture([string]$exe, [string[]]$argsList) {
  $tmp = Join-Path $env:TEMP ("audit-" + [guid]::NewGuid().ToString('N').Substring(0,8))
  $out = "$tmp.out"; $err = "$tmp.err"
  $p = Start-Process -FilePath $exe -ArgumentList $argsList -NoNewWindow -Wait -PassThru `
       -RedirectStandardOutput $out -RedirectStandardError $err
  $text = ((Get-Content $out -Raw -ErrorAction SilentlyContinue) + (Get-Content $err -Raw -ErrorAction SilentlyContinue))
  Remove-Item $out, $err -Force -ErrorAction SilentlyContinue
  return @{ Code = $p.ExitCode; Text = [string]$text }
}

Invoke-Check 'harness/repo drift' {
  # Drift compares a live harness against a repo clone. If this script is inside
  # the repo (a clone with no separate harness), there is nothing to compare.
  if ($harnessIsRepo -or -not (Test-Path (Join-Path $RepoRoot 'install.ps1'))) {
    return @{ Ok = $true; Detail = 'n/a (no separate harness to compare)' }
  }
  $r = Invoke-Capture 'powershell' @('-ExecutionPolicy','Bypass','-File',(Join-Path $RepoRoot 'tools\sync.ps1'),'-HarnessRoot',$HarnessRoot)
  @{ Ok = ($r.Code -eq 0); Detail = $(if ($r.Code -eq 0) { 'clean' } else { 'files drifted - run sync.ps1 -Promote or -Deploy' }) }
}

Invoke-Check 'prompt volatile literals' {
  $r = Invoke-Capture 'node' @("$HarnessRoot\tools\prompt-lint.mjs",'scan','--root',$HarnessRoot)
  $n = ([regex]::Matches($r.Text, '\d+ volatile')).Count
  @{ Ok = ($r.Code -eq 0); Detail = $(if ($r.Code -eq 0) { 'none' } else { 'volatile content in a prompt surface' }) }
}

# A repo clone has no baseline of its own (the harness records one at install
# time), so an unbaselined tree is 'n/a', not a defect.
Invoke-Check 'prompt-cache baseline' {
  if (-not (Test-Path (Join-Path $HarnessRoot '.prompt-lint\baseline.json'))) {
    return @{ Ok = $true; Detail = 'n/a (no baseline in this tree)' }
  }
  $r = Invoke-Capture 'node' @((Join-Path $HarnessRoot 'tools\prompt-lint.mjs'),'check','--root',$HarnessRoot)
  @{ Ok = ($r.Code -eq 0); Detail = $(if ($r.Code -eq 0) { 'matches' } else { 'surfaces drifted - re-run baseline if intentional' }) }
}

Invoke-Check 'skills registry' {
  $r = Invoke-Capture 'node' @("$HarnessRoot\tools\skills-doctor.mjs",'--installed',"$HOME\.agents\skills",'--repo',"$RepoRoot\skills")
  @{ Ok = ($r.Code -eq 0); Detail = $(if ($r.Code -eq 0) { 'healthy' } else { 'unparsable/truncated/orphan skills' }) }
}

Invoke-Check 'CONTEXT.md coverage' {
  # Scope the glossary to code the PROJECT owns. Without a scope the scan pulls
  # symbols out of bundled third-party skill scripts and reports them as
  # undocumented domain concepts, which is noise, not a finding.
  $effectiveScope = if ($Scope.Count) { $Scope } else { @('agent','tools') }
  $a = @("$HarnessRoot\tools\glossary.mjs",'check','--root',$RepoRoot,'--scope',($effectiveScope -join ','))
  $r = Invoke-Capture 'node' $a
  # Exit 2 means "no CONTEXT.md" — report it, do not call it a regression.
  $detail = if ($r.Code -eq 0) { "all documented ($($effectiveScope -join ','))" } elseif ($r.Code -eq 2) { 'no CONTEXT.md' } else { 'undocumented public symbols' }
  @{ Ok = ($r.Code -eq 0 -or $r.Code -eq 2); Detail = $detail }
}

# The gate is what makes the protocol enforceable; if it is broken, every rule it
# backs silently reverts to a suggestion.
Invoke-Check 'tier gate present and working' {
  $wf = Join-Path $HarnessRoot 'tools\workflow.mjs'
  if (-not (Test-Path $wf)) { return @{ Ok = $false; Detail = 'workflow.mjs missing - the protocol is back to being prose' } }
  $tmp = Join-Path $env:TEMP ("wf-" + [guid]::NewGuid().ToString('N').Substring(0,8))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    $null = Invoke-Capture 'node' @($wf,'start','--tier','T0','--task','probe','--root',$tmp)
    $ok = Invoke-Capture 'node' @($wf,'check','--root',$tmp)
    $null = Invoke-Capture 'node' @($wf,'start','--tier','T2','--task','p2','--force','--root',$tmp)
    $blocked = Invoke-Capture 'node' @($wf,'check','--root',$tmp)
    @{ Ok = ($ok.Code -eq 0 -and $blocked.Code -ne 0); Detail = 'T0 passes, T2 blocks' }
  } finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}

Invoke-Check 'architecture report engine' {
  $am = Join-Path $HarnessRoot 'tools\archmap.mjs'
  $ar = Join-Path $HarnessRoot 'tools\archmap-report.mjs'
  if (-not (Test-Path $am)) { return @{ Ok = $false; Detail = 'archmap.mjs missing' } }
  if (-not (Test-Path $ar)) { return @{ Ok = $false; Detail = 'archmap-report.mjs missing' } }
  @{ Ok = $true; Detail = 'archmap.mjs and archmap-report.mjs present' }
}

Invoke-Check 'portable core specification' {
  $cp = Join-Path $HarnessRoot 'core\PORTABLE.md'
  if (-not (Test-Path $cp)) { return @{ Ok = $false; Detail = 'core\PORTABLE.md missing' } }
  @{ Ok = $true; Detail = 'core\PORTABLE.md present' }
}

Invoke-Check 'codemap currency' {
  $state = Join-Path $RepoRoot '.codemap\state.json'
  if (-not (Test-Path $state)) { return @{ Ok = $true; Detail = 'not initialised (optional)' } }
  $r = Invoke-Capture 'node' @("$HarnessRoot\tools\codemap.mjs",'changes','--root',$RepoRoot)
  $m = [regex]::Match($r.Text, 'changes: \+(\d+) ~(\d+) -(\d+)')
  if (-not $m.Success) { return @{ Ok = $true; Detail = 'no change data' } }
  $n = [int]$m.Groups[1].Value + [int]$m.Groups[2].Value + [int]$m.Groups[3].Value
  @{ Ok = $true; Detail = $(if ($n -eq 0) { 'current' } else { "$n file(s) changed - CODEMAP.md may be stale" }) }
}

if ($Json) {
  @{ results = $results; findings = $findings; ok = ($findings.Count -eq 0) } | ConvertTo-Json -Depth 4
} else {
  Write-Host "`n=== Harness audit ===`n"
  $results | Format-Table -AutoSize
  if ($findings.Count -eq 0) {
    Write-Host "`nall $($results.Count) checks clean`n" -ForegroundColor Green
  } else {
    Write-Host "`n$($findings.Count)/$($results.Count) checks need attention: $($findings -join ', ')`n" -ForegroundColor Yellow
  }
}

exit $(if ($findings.Count -gt 0) { 1 } else { 0 })
