#Requires -Version 5.1
<#
.SYNOPSIS
  Nullform Workflow — one-command installer (Windows).
  Installs the OMP+Paseo orchestration harness: agent definitions, skills, rules,
  MCP configs, Paseo profile, and cost tool.

  Paths are OMP-native on purpose. OMP reads MCP and models from the agent dir:
    ~/.omp/agent/mcp.json        (MCP servers)
    ~/.omp/agent/models.yml      (providers/models)
    ~/.omp/agent/agents/*.md     (task agents, via junction to the harness root)
    ~/.omp/agent/rules/*.md      (rules, addressable as rule://<name>)
    ~/.omp/agent/AGENTS.md       (orchestrator law, auto-loaded user context)
    ~/.agents/skills/*/SKILL.md  (skills, agents provider)
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
  $text = $text.Replace('__NULLFORM_GATEWAY_KEY__', $secrets['NULLFORM_GATEWAY_KEY'])
  $text = $text.Replace('__HINDSIGHT_TOKEN__', $secrets['HINDSIGHT_TOKEN'])
  $text = $text.Replace('__CRAWL4AI_TOKEN__', $secrets['CRAWL4AI_TOKEN'])
  $text = $text.Replace('__GOOGLE_AI_STUDIO_KEY__', $secrets['GOOGLE_AI_STUDIO_KEY'])
  return $text
}
# UTF8 without BOM: a BOM makes the first YAML/JSON key unparsable.
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function WriteText([string]$path, [string]$text) {
  [System.IO.File]::WriteAllText($path, $text, $script:Utf8NoBom)
}

# ---------- 3. Files ----------
Write-Host "-- Installing files"
$agentDir = "$HOME\.omp\agent"
$dirs = @("$HarnessRoot\agent", "$HarnessRoot\agent\agents", "$HarnessRoot\tools",
          $agentDir, "$agentDir\rules", "$HOME\.agents\skills")
$dirs | ForEach-Object { New-Item -ItemType Directory -Force -Path $_ | Out-Null }

Copy-Item "$PSScriptRoot\agent\AGENTS.md" "$HarnessRoot\agent\AGENTS.md" -Force
Copy-Item "$PSScriptRoot\agent\AGENTS.md" "$agentDir\AGENTS.md" -Force
Copy-Item "$PSScriptRoot\agent\agents\*" "$HarnessRoot\agent\agents\" -Force -Recurse
Copy-Item "$PSScriptRoot\tools\*" "$HarnessRoot\tools\" -Force -Recurse
if (Test-Path "$PSScriptRoot\templates") { Copy-Item "$PSScriptRoot\templates\*" "$HarnessRoot\templates\" -Force -Recurse -ErrorAction SilentlyContinue }

# Skills: skip marketplace-lock-managed skills so the install does not desync ~/.agents/.skill-lock.json.
$lockPath = "$HOME\.agents\.skill-lock.json"
$skipSkills = @()
if (Test-Path $lockPath) {
  # A lock entry alone is not proof of an installed skill: skip only when the
  # locked skill is actually present, or a locked-but-missing skill is dropped.
  $lockPathLocal = $lockPath
  $lockedNames = @((Get-Content $lockPathLocal -Raw -Encoding UTF8 | ConvertFrom-Json).skills.PSObject.Properties.Name)
  $skipSkills = @($lockedNames | Where-Object { Test-Path "$HOME\.agents\skills\$_\SKILL.md" })
}
$copied = 0; $skipped = @()
Get-ChildItem "$PSScriptRoot\skills" -Directory | ForEach-Object {
  if ($skipSkills -contains $_.Name) { $skipped += $_.Name; return }
  Copy-Item $_.FullName "$HOME\.agents\skills\" -Force -Recurse
  $script:copied++
}
Ok "agent defs, skills ($copied copied$(if ($skipped) { ", $(($skipped).Count) lock-managed skipped: $($skipped -join ', ')" })), tools copied"

# Rule -> native user rules dir (highest-priority source; resolvable as rule://<name>).
Copy-Item "$PSScriptRoot\rules\*" "$agentDir\rules\" -Force -Recurse
Ok "rules -> $agentDir\rules"

# models.yml: MUST be map-form (providers.<id>) or the provider registers under the
# first model-id segment instead of its declared name, breaking every role selector.
$models = Patch (Get-Content "$PSScriptRoot\agent\models.yml.example" -Raw)
WriteText "$agentDir\models.yml" $models
Ok "models.yml -> $agentDir\models.yml"

# mcp.json
$mcp = Patch (Get-Content "$PSScriptRoot\agent\mcp.json.example" -Raw)
if (-not $secrets['HINDSIGHT_TOKEN']) {
  # Drop the empty bearer header entirely; sending "Bearer " is worse than no header.
  $mcpObj = $mcp | ConvertFrom-Json
  $mcpObj.mcpServers.hindsight.headers.PSObject.Properties.Remove('Authorization')
  $mcp = $mcpObj | ConvertTo-Json -Depth 30
  Warn "HINDSIGHT_TOKEN empty -> hindsight Authorization header omitted"
}
if (-not $secrets['CRAWL4AI_TOKEN']) {
  # Same reasoning as hindsight: never send an empty "Bearer " header.
  $mcpObj = $mcp | ConvertFrom-Json
  $mcpObj.mcpServers.crawl4ai.headers.PSObject.Properties.Remove('Authorization')
  $mcp = $mcpObj | ConvertTo-Json -Depth 30
  Warn "CRAWL4AI_TOKEN empty -> crawl4ai Authorization header omitted (endpoint still requires auth; set the token and re-run)"
}
WriteText "$agentDir\mcp.json" $mcp
Ok "mcp.json -> $agentDir\mcp.json"

# OpenCode auth is only written when the key is real; an empty key would break OpenCode's Google auth.
if ($secrets['GOOGLE_AI_STUDIO_KEY']) {
  $authDir = "$HOME\.local\share\opencode"
  New-Item -ItemType Directory -Force -Path $authDir | Out-Null
  WriteText "$authDir\auth.json" (Patch (Get-Content "$PSScriptRoot\agent\opencode-auth.json.example" -Raw))
  Ok "opencode auth.json written"
} else {
  Warn "GOOGLE_AI_STUDIO_KEY empty -> opencode auth.json not written (left untouched)"
}

if (-not (Test-Path "$agentDir\config.yml")) {
  Copy-Item "$PSScriptRoot\agent\config.yml" "$agentDir\config.yml"
  Ok "config.yml installed (fresh)"
} else {
  Warn "config.yml exists -> left untouched (merge by hand if needed)"
}

# ---------- 4. Junction: single source for agent defs ----------
Write-Host "-- Agent defs junction"
$junction = "$agentDir\agents"
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
    Copy-Item $paseoCfg "$paseoCfg.nullform-backup" -Force
    # -Encoding UTF8 is required: the default ANSI read mangles the non-ASCII
    # lane glyphs in the profile notes and the daemon system prompt.
    $cfg = Get-Content $paseoCfg -Raw -Encoding UTF8 | ConvertFrom-Json
    # PS 5.1 ConvertFrom-Json returns an array that Add-Member/ConvertTo-Json
    # re-wraps as {"value":[...],"Count":N}; copy into a plain array first.
    $profiles = @()
    Get-Content "$PSScriptRoot\paseo\profiles.json" -Raw -Encoding UTF8 | ConvertFrom-Json | ForEach-Object { $profiles += $_ }
    if (-not $cfg.daemon) { $cfg | Add-Member -NotePropertyName daemon -NotePropertyValue ([pscustomobject]@{}) }
    $cfg.daemon | Add-Member -NotePropertyName agentProfiles -NotePropertyValue $profiles -Force
    WriteText $paseoCfg ($cfg | ConvertTo-Json -Depth 30)
    try { & paseo daemon reload | Out-Null; Ok "profile 'Orchestrator' installed + daemon reloaded" }
    catch { Warn "profile written; run 'paseo daemon reload' manually" }
  } else { Warn "~/.paseo/config.json not found -> install Paseo first, then re-run" }
} else { Warn "paseo CLI not found or -SkipPaseo -> profile step skipped" }

Write-Host "`n=== Done. Next: open a NEW session and run verify.ps1 ===`n"
