#Requires -Version 5.1
<#
.SYNOPSIS
  One-command harness health audit.
#>
param(
  [string]$HarnessRoot = '',
  [string]$RepoRoot    = '',
  [string[]]$Scope     = @(),
  [switch]$Json
)

$ErrorActionPreference = 'Continue'
$scriptRoot = $PSScriptRoot
if (-not $scriptRoot) { $scriptRoot = (Get-Location).Path }

$verifyScript = Join-Path $scriptRoot 'verify.mjs'
if (-not (Test-Path $verifyScript)) {
  $verifyScript = Join-Path $scriptRoot 'tools\verify.mjs'
}

$forwardArgs = @($verifyScript, '--profile', 'audit')
if ($HarnessRoot) { $forwardArgs += @('--harness', $HarnessRoot) }
if ($RepoRoot) { $forwardArgs += @('--root', $RepoRoot) }
if ($Scope -and $Scope.Count) { $forwardArgs += @('--scope', ($Scope -join ',')) }
if ($Json) { $forwardArgs += @('--json') }
if ($args) { $forwardArgs += $args }

& node @forwardArgs
exit $LASTEXITCODE
