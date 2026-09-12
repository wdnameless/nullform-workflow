#Requires -Version 5.1
<#
.SYNOPSIS
  Nullform Workflow — one-command installer (Windows).
  Installs the OMP+Paseo orchestration harness: agent definitions, skills, rules,
  MCP configs, Paseo profile, and cost tool.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install.ps1
  powershell -ExecutionPolicy Bypass -File install.ps1 -SecretsFile .\secrets.env -HarnessRoot D:\ohmypi
#>
param(
  [string]$SecretsFile = (Join-Path $PSScriptRoot 'secrets.env'),
  [string]$HarnessRoot = 'D:\ohmypi',
  [switch]$SkipPaseo
)

$ErrorActionPreference = 'Stop'
function Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!!] $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "  [XX] $m" -ForegroundColor Red; exit 1 }

Write-Host "`n=== Nullform Workflow installer ===`n"

# ---------- 1. Dependencies ----------
Write-Host "-- Dependencies"
foreach ($cmd in 'python', 'node', 'bun') {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { Die "$cmd not found in PATH. Install it first." }
  Ok "$cmd present"
}
if (-not (Get-Command openspec -ErrorAction SilentlyContinue)) {
  Warn "openspec missing -> installing @fission-ai/openspec@latest via bun"
  & bun add -g '@fission-ai/openspec@latest' | Out-Null
}
& openspec --version | Out-Null
Ok "openspec $(& openspec --version)"

# ---------- 2. Secrets ----------
Write-Host "-- Secrets"
$secrets = @{}
if (Test-Path $SecretsFile) {
  Get-Content $SecretsFile | ForEach-Object {
    if ($_ -match '^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$' -and $_ -notmatch '^\s*#') { $secrets[$Matches[1]] = $Matches[2] }
  }
  Ok "loaded $(($secrets.Keys).Count) keys from $SecretsFile"
}
foreach ($k in 'NULLFORM_GATEWAY_KEY', 'HINDSIGHT_TOKEN', 'CRAWL4AI_TOKEN', 'GOOGLE_AI_STUDIO_KEY') {
  if (-not $secrets[$k]) {
    $secrets[$k] = Read-Host "  Enter $k (leave empty to configure later)"
    if (-not $secrets[$k]) { Warn "$k empty -> placeholder left in configs" }
  }
}
function Patch([string]$text) {
  return $text.Replace('__NULLFORM_GATEWAY_KEY__', $secrets['NULLFORM_GATEWAY_KEY']) `
              .Replace('__HINDSIGHT_TOKEN__', $secrets['HINDSIGHT_TOKEN']) `
              .Replace('__CRAWL4AI_TOKEN__', $secrets['CRAWL4AI_TOKEN']) `
              .Replace('__GOOGLE_AI_STUDIO_KEY__', $secrets['GOOGLE_AI_STUDIO_KEY'])
}

# ---------- 3. Files ----------
Write-Host "-- Installing files"
$dirs = @("$HarnessRoot\agent", "$HarnessRoot\mcp", "$HarnessRoot\tools",
          "$HOME\.omp\agent", "$HOME\.agents\skills", "$HOME\.agents\rules",
          "$HOME\.local\share\opencode")
$dirs | ForEach-Object { New-Item -ItemType Directory -Force -Path $_ | Out-Null }

Copy-Item "$PSScriptRoot\agent\AGENTS.md" "$HarnessRoot\agent\AGENTS.md" -Force
Copy-Item "$PSScriptRoot\agent\agents\*" "$HarnessRoot\agent\agents\" -Force -Recurse
Copy-Item "$PSScriptRoot\skills\*" "$HOME\.agents\skills\" -Force -Recurse
Copy-Item "$PSScriptRoot\rules\*" "$HOME\.agents\rules\" -Force -Recurse
Copy-Item "$PSScriptRoot\mcp\*" "$HarnessRoot\mcp\" -Force -Recurse
Copy-Item "$PSScriptRoot\tools\*" "$HarnessRoot\tools\" -Force -Recurse
Ok "agent defs, skills, rules, mcp helpers, tools copied"

(Patch (Get-Content "$PSScriptRoot\agent\models.yml.example" -Raw)) | Set-Content "$HarnessRoot\agent\models.yml" -Encoding UTF8
(Patch (Get-Content "$PSScriptRoot\agent\mcp.json.example" -Raw)) | Set-Content "$HarnessRoot\agent\mcp.json" -Encoding UTF8
(Patch (Get-Content "$PSScriptRoot\agent\opencode-auth.json.example" -Raw)) | Set-Content "$HOME\.local\share\opencode\auth.json" -Encoding UTF8
Ok "models.yml, mcp.json, opencode auth patched with secrets"

if (-not (Test-Path "$HOME\.omp\agent\config.yml")) {
  Copy-Item "$PSScriptRoot\agent\config.yml" "$HOME\.omp\agent\config.yml"
  Ok "config.yml installed (fresh)"
} else {
  Warn "config.yml exists -> left untouched (merge by hand if needed)"
}

# ---------- 4. Junction: single source for agent defs ----------
Write-Host "-- Agent defs junction"
$junction = "$HOME\.omp\agent\agents"
if (Test-Path $junction) {
  $item = Get-Item $junction -Force
  if ($item.LinkType -eq 'Junction') { Ok "junction already present" }
  else { Warn "$junction exists as a real dir -> left untouched (defs live in $HarnessRoot\agent\agents)" }
} else {
  New-Item -ItemType Junction -Path $junction -Target "$HarnessRoot\agent\agents" | Out-Null
  Ok "junction $junction -> $HarnessRoot\agent\agents"
}

# ---------- 5. Paseo profile ----------
if (-not $SkipPaseo -and (Get-Command paseo -ErrorAction SilentlyContinue)) {
  Write-Host "-- Paseo profile"
  $paseoCfg = "$HOME\.paseo\config.json"
  if (Test-Path $paseoCfg) {
    $cfg = Get-Content $paseoCfg -Raw | ConvertFrom-Json
    $profiles = Get-Content "$PSScriptRoot\paseo\profiles.json" -Raw | ConvertFrom-Json
    if (-not $cfg.daemon) { $cfg | Add-Member -NotePropertyName daemon -NotePropertyValue ([pscustomobject]@{}) }
    $cfg.daemon | Add-Member -NotePropertyName agentProfiles -NotePropertyValue $profiles -Force
    $cfg | ConvertTo-Json -Depth 30 | Set-Content $paseoCfg -Encoding UTF8
    try { & paseo daemon reload | Out-Null; Ok "profile 'Orchestrator' installed + daemon reloaded" }
    catch { Warn "profile written; run 'paseo daemon reload' manually" }
  } else { Warn "~/.paseo/config.json not found -> install Paseo first, then re-run" }
} else { Warn "paseo CLI not found or -SkipPaseo -> profile step skipped" }

Write-Host "`n=== Done. Next: open a NEW session and run verify.ps1 ===`n"
