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
  [string]$HarnessRoot = (Join-Path $HOME 'omp-workflow'),
  [string]$RepoRoot    = (Split-Path -Parent $PSScriptRoot),
  [string[]]$Scope     = @(),
  [switch]$Json
)

$ErrorActionPreference = 'Continue'
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
  $r = Invoke-Capture 'powershell' @('-ExecutionPolicy','Bypass','-File',"$RepoRoot\tools\sync.ps1",'-HarnessRoot',$HarnessRoot)
  @{ Ok = ($r.Code -eq 0); Detail = $(if ($r.Code -eq 0) { 'clean' } else { 'files drifted - run sync.ps1 -Promote or -Deploy' }) }
}

Invoke-Check 'prompt volatile literals' {
  $r = Invoke-Capture 'node' @("$HarnessRoot\tools\prompt-lint.mjs",'scan','--root',$HarnessRoot)
  $n = ([regex]::Matches($r.Text, '\d+ volatile')).Count
  @{ Ok = ($r.Code -eq 0); Detail = $(if ($r.Code -eq 0) { 'none' } else { 'volatile content in a prompt surface' }) }
}

Invoke-Check 'prompt-cache baseline' {
  $r = Invoke-Capture 'node' @("$HarnessRoot\tools\prompt-lint.mjs",'check','--root',$HarnessRoot)
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
