#Requires -Version 5.1
<#
.SYNOPSIS
  OMP workflow harness - one-command installer.

.DESCRIPTION
  Installs an orchestration harness for OMP: agent definitions, rules, skills,
  tools, and optional MCP/Paseo configuration. Nothing here is provider-specific
  or machine-specific - you supply your own model endpoint.

  Where things land (all OMP-native paths):
    <HarnessRoot>\agent\           agent definitions + tools (the "live tree")
    <HarnessRoot>\agent\agents\    role definitions
    <HarnessRoot>\tools\           codemap / prompt-lint / replay / audit ...
    ~/.omp/agent/AGENTS.md         orchestrator law (auto-loaded every session)
    ~/.omp/agent/rules/*.md        rules, addressable as rule://<name>
    ~/.omp/agent/models.yml        your provider(s)          (needs your input)
    ~/.omp/agent/mcp.json          optional MCP fleet        (needs your input)
    ~/.omp/agent/config.yml        model role mapping        (needs your input)
    ~/.agents/skills/*/SKILL.md    skills registry

  Every step is idempotent; re-run after a `git pull` to update.

.EXAMPLE
  # Fully interactive (the one-prompt path):
  powershell -ExecutionPolicy Bypass -File install.ps1

.EXAMPLE
  # Non-interactive, from a filled-in secrets.env:
  copy secrets.example.env secrets.env   # then edit it
  powershell -ExecutionPolicy Bypass -File install.ps1 -NonInteractive
#>
param(
  [string]$SecretsFile = (Join-Path $PSScriptRoot 'secrets.env'),
  [string]$HarnessRoot = (Join-Path $HOME 'omp-workflow'),
  [switch]$NonInteractive,
  [switch]$SkipPaseo,
  [switch]$SkipMcp
)

$ErrorActionPreference = 'Stop'
function Ok($m)   { Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!!] $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "  [XX] $m" -ForegroundColor Red; exit 1 }
function Ask($prompt, $default = '') {
  if ($NonInteractive) { return $default }
  $shown = if ($default) { "$prompt [$default]" } else { $prompt }
  $v = Read-Host "  $shown"
  if (-not $v) { return $default }
  return $v
}

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function WriteText([string]$path, [string]$text) {
  $dir = Split-Path -Parent $path
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($path, $text, $Utf8NoBom)   # a BOM makes the first YAML/JSON key unparsable
}

Write-Host "`n=== OMP workflow installer ===`n"
Write-Host "  harness root : $HarnessRoot"
Write-Host "  source       : $PSScriptRoot`n"

# ---------- 1. Dependencies ----------
Write-Host "-- Dependencies"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Die "node not found in PATH. The harness tools (codemap, replay, lint) are Node scripts. Install Node 18+."
}
Ok "node $(& node --version)"

if (-not (Get-Command omp -ErrorAction SilentlyContinue)) {
  Warn "omp not found in PATH - install OMP, then start a new session for the harness to take effect"
} else { Ok "omp present" }

if (-not (Get-Command openspec -ErrorAction SilentlyContinue)) {
  Warn "openspec not found - the T2 4-Wave protocol needs it for change scaffolding."
  Warn "  install however you prefer (e.g. 'npm i -g @fission-ai/openspec') and re-run."
} else { Ok "openspec $(& openspec --version 2>$null)" }

# ---------- 2. Inputs (secrets.env or prompts) ----------
Write-Host "`n-- Configuration"
$cfgVals = @{}
if (Test-Path $SecretsFile) {
  Get-Content $SecretsFile | ForEach-Object {
    if ($_ -match '^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$' -and $_ -notmatch '^\s*#') { $cfgVals[$Matches[1]] = $Matches[2] }
  }
  Ok "loaded $(($cfgVals.Keys).Count) value(s) from $SecretsFile"
}

# Which of these are answered decides what gets written. All are optional:
# without a provider you get the full harness minus model routing.
function Value($key, $prompt, $default = '') {
  if ($cfgVals[$key]) { return $cfgVals[$key] }
  return (Ask $prompt $default)
}

$providerBase = Value 'PROVIDER_BASE_URL' 'Model provider base URL (OpenAI-compatible, ends in /v1) - blank to skip'
$providerKey  = Value 'PROVIDER_API_KEY'  'Model provider API key - blank to skip'
$modelId      = Value 'DEFAULT_MODEL_ID'  'Default model id (as your provider names it)' 'default'

if (-not $providerBase) {
  Warn "no provider given -> models.yml/config.yml NOT written."
  Warn "  fill them later, or re-run with secrets.env. Everything else still installs."
} else { Ok "provider base: $providerBase" }

$memoryUrl   = Value 'MEMORY_MCP_URL' 'Memory MCP URL (optional)'
$memoryToken = Value 'MEMORY_MCP_TOKEN' ''
$crawlUrl    = Value 'CRAWL_MCP_URL' 'Crawl MCP URL (optional)'
$crawlToken  = Value 'CRAWL_MCP_TOKEN' ''
$context7Key = Value 'CONTEXT7_API_KEY' 'context7 API key (optional; works keyless)'

function Patch([string]$text) {
  $map = @{
    '__PROVIDER_BASE_URL__' = $providerBase
    '__PROVIDER_API_KEY__'  = $providerKey
    '__DEFAULT_MODEL_ID__'  = $modelId
    '__DEFAULT_MODEL__'     = "my-provider/$modelId"
    '__MEMORY_MCP_URL__'    = $memoryUrl
    '__MEMORY_TOKEN__'      = $memoryToken
    '__CRAWL_MCP_URL__'     = $crawlUrl
    '__CRAWL_TOKEN__'       = $crawlToken
    '__CONTEXT7_API_KEY__'  = $context7Key
  }
  foreach ($k in $map.Keys) { $text = $text.Replace($k, $map[$k]) }
  return $text
}

# ---------- 3. File layout ----------
Write-Host "`n-- Files"
$agentDir = "$HOME\.omp\agent"
foreach ($d in @("$HarnessRoot\agent", "$HarnessRoot\agent\agents", "$HarnessRoot\tools",
                 "$HarnessRoot\templates", $agentDir, "$agentDir\rules",
                 "$HOME\.agents\rules", "$HOME\.agents\skills")) {
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}

Copy-Item "$PSScriptRoot\agent\AGENTS.md" "$HarnessRoot\agent\AGENTS.md" -Force
# AGENTS.md ships path-templated so it survives being installed anywhere. Resolve
# <HARNESS> at install time: without this the agent cannot find the full protocol.
$agentsText = (Get-Content "$PSScriptRoot\agent\AGENTS.md" -Raw) -replace '<HARNESS>', ($HarnessRoot -replace '\\','/')
WriteText "$agentDir\AGENTS.md" $agentsText
# A one-line pointer, so agent defs can be located from any working directory.
WriteText "$agentDir\.harness-root" ("$HarnessRoot" + [Environment]::NewLine)
Copy-Item "$PSScriptRoot\agent\agents\*" "$HarnessRoot\agent\agents\" -Force -Recurse
# Same substitution for any role/rule file that references the harness root.
$slashRoot = $HarnessRoot -replace '\\','/'
Get-ChildItem "$HarnessRoot\agent\agents\*.md", "$PSScriptRoot\rules\*.md" -ErrorAction SilentlyContinue | ForEach-Object {
  $t = Get-Content $_.FullName -Raw
  if ($t -match '<HARNESS>') { WriteText $_.FullName ($t -replace '<HARNESS>', $slashRoot) }
}
Copy-Item "$PSScriptRoot\tools\*" "$HarnessRoot\tools\" -Force -Recurse
# Also drop the repo-level scripts into the harness root, so an install made
# without keeping the clone can still verify and audit itself.
foreach ($f in 'verify.ps1', 'audit.ps1', 'README.md', 'CONTEXT.md', 'secrets.example.env') {
  $src = Join-Path $PSScriptRoot $f
  if (Test-Path $src) { Copy-Item $src "$HarnessRoot\$f" -Force }
}
if (Test-Path "$PSScriptRoot\skills") { Copy-Item "$PSScriptRoot\skills" "$HarnessRoot\skills" -Force -Recurse }
if (Test-Path "$PSScriptRoot\templates") { Copy-Item "$PSScriptRoot\templates\*" "$HarnessRoot\templates\" -Force -Recurse }
if (Test-Path "$PSScriptRoot\CONTEXT.md") { Copy-Item "$PSScriptRoot\CONTEXT.md" "$HarnessRoot\CONTEXT.md" -Force }
Ok "agent defs + tools -> $HarnessRoot"

# Skills: skip marketplace-lock-managed ones so the install does not desync
# ~/.agents/.skill-lock.json (a lock entry alone is not proof of installation).
$lockPath = "$HOME\.agents\.skill-lock.json"
$skipSkills = @()
if (Test-Path $lockPath) {
  $lockedNames = @((Get-Content $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json).skills.PSObject.Properties.Name)
  $skipSkills = @($lockedNames | Where-Object { Test-Path "$HOME\.agents\skills\$_\SKILL.md" })
}
$copied = 0; $skipped = @()
Get-ChildItem "$PSScriptRoot\skills" -Directory | ForEach-Object {
  if ($skipSkills -contains $_.Name) { $skipped += $_.Name; return }
  Copy-Item $_.FullName "$HOME\.agents\skills\" -Force -Recurse
  $script:copied++
}
Ok "skills: $copied installed$(if ($skipped) { ", $(($skipped).Count) lock-managed skipped" })"

Copy-Item "$PSScriptRoot\rules\*" "$agentDir\rules\" -Force -Recurse
Copy-Item "$PSScriptRoot\rules\*" "$HOME\.agents\rules\" -Force -Recurse -ErrorAction SilentlyContinue
Get-ChildItem "$agentDir\rules\*.md" -ErrorAction SilentlyContinue | ForEach-Object {
  $t = Get-Content $_.FullName -Raw
  if ($t -match '<HARNESS>') { WriteText $_.FullName ($t -replace '<HARNESS>', $slashRoot) }
}
Ok "rules -> $agentDir\rules (and ~/.agents\rules)"

# ---------- 4. Provider + model routing ----------
if ($providerBase) {
  WriteText "$agentDir\models.yml" (Patch (Get-Content "$PSScriptRoot\agent\models.yml.example" -Raw))
  Ok "models.yml -> $agentDir\models.yml (provider: my-provider)"

  if (-not (Test-Path "$agentDir\config.yml")) {
    WriteText "$agentDir\config.yml" (Patch (Get-Content "$PSScriptRoot\agent\config.yml.example" -Raw))
    Ok "config.yml installed (roles -> my-provider/$modelId)"
  } else {
    Warn "config.yml already exists -> left untouched. Update its modelRoles to 'my-provider/$modelId' by hand."
  }
} else {
  Warn "models.yml + config.yml skipped (no provider supplied)"
}

# ---------- 5. MCP fleet (optional) ----------
if (-not $SkipMcp) {
  $mcpTarget = "$agentDir\mcp.json"
  $mcpExisting = Test-Path $mcpTarget
  if ($mcpExisting -and -not $NonInteractive) {
    $ans = Ask "mcp.json already exists - overwrite with the sanitized example? (y/N)" 'n'
    if ($ans -notmatch '^[Yy]') { $mcpExisting = $false; Warn "mcp.json left untouched" }
  } elseif ($mcpExisting -and $NonInteractive) {
    Warn "mcp.json exists -> left untouched (delete it to regenerate)"
    $mcpExisting = $false
  }
  if (-not $mcpExisting -or $NonInteractive) {
    if (-not $mcpExisting) {
      $mcp = Patch (Get-Content "$PSScriptRoot\agent\mcp.json.example" -Raw) | ConvertFrom-Json
      # Drop entries the user did not supply a value for: an absent server is
      # better than one that fails to connect on every session boot.
      $drop = @()
      if (-not $memoryUrl)   { $drop += 'memory' }
      if (-not $crawlUrl)    { $drop += 'crawl4ai' }
      if (-not $context7Key) { $drop += 'context7' }
      foreach ($d in $drop) { $mcp.mcpServers.PSObject.Properties.Remove($d) }
      WriteText $mcpTarget ($mcp | ConvertTo-Json -Depth 30)
      $kept = ($mcp.mcpServers.PSObject.Properties.Name) -join ', '
      Ok "mcp.json -> $mcpTarget (kept: $kept)"
      if ($drop.Count) { Warn "dropped unconfigured: $($drop -join ', ') - re-run with values to add them" }
    }
  }
} else { Warn "MCP step skipped (-SkipMcp)" }

# ---------- 6. Agent-defs junction ----------
$junction = "$agentDir\agents"
if (Test-Path $junction) {
  $item = Get-Item $junction -Force
  if ($item.LinkType -eq 'Junction') {
    $target = ($item.Target | Select-Object -First 1)
    if ($target -ne "$HarnessRoot\agent\agents") {
      Remove-Item $junction -Force -Recurse
      New-Item -ItemType Junction -Path $junction -Target "$HarnessRoot\agent\agents" | Out-Null
      Ok "junction re-pointed -> $HarnessRoot\agent\agents"
    } else { Ok "junction already correct" }
  } else {
    Warn "$junction is a real directory -> agent defs there will shadow the harness. Move it aside to use the junction."
  }
} else {
  New-Item -ItemType Junction -Path $junction -Target "$HarnessRoot\agent\agents" | Out-Null
  Ok "junction $junction -> $HarnessRoot\agent\agents"
}

# ---------- 7. Paseo profile (optional) ----------
if (-not $SkipPaseo -and (Get-Command paseo -ErrorAction SilentlyContinue)) {
  $paseoCfg = "$HOME\.paseo\config.json"
  if (Test-Path $paseoCfg) {
    Copy-Item $paseoCfg "$paseoCfg.bak" -Force
    # -Encoding UTF8 is required: the default ANSI read mangles the non-ASCII lane glyphs.
    $cfg = Get-Content $paseoCfg -Raw -Encoding UTF8 | ConvertFrom-Json
    $profiles = @()
    Get-Content "$PSScriptRoot\paseo\profiles.json" -Raw -Encoding UTF8 |
      ConvertFrom-Json | ForEach-Object { $profiles += $_ }
    # Point the profile at whatever model the user actually configured.
    if ($providerBase) {
      foreach ($p in $profiles) { $p.model = "my-provider/$modelId" }
    }
    if (-not $cfg.daemon) { $cfg | Add-Member -NotePropertyName daemon -NotePropertyValue ([pscustomobject]@{}) }
    $cfg.daemon | Add-Member -NotePropertyName agentProfiles -NotePropertyValue $profiles -Force
    WriteText $paseoCfg ($cfg | ConvertTo-Json -Depth 30)
    try { & paseo daemon reload | Out-Null; Ok "Paseo profile installed + daemon reloaded" }
    catch { Warn "profile written; run 'paseo daemon reload' manually" }
  } else { Warn "~/.paseo/config.json not found -> install Paseo first, then re-run" }
} else { Warn "Paseo not found or -SkipPaseo -> profile step skipped" }

# ---------- 8. Baseline the prompt surfaces ----------
# Records a hash per prompt surface so a later edit is visible as a cache-prefix
# change rather than a silent full-price re-bill.
if (Test-Path "$HarnessRoot\tools\prompt-lint.mjs") {
  & node "$HarnessRoot\tools\prompt-lint.mjs" baseline --root $HarnessRoot | Out-Null
  Ok "prompt-cache baseline recorded"
}

Write-Host "`n=== Installed ==="
Write-Host @"

  Next:
    1. Open a NEW OMP session (skills, MCP, and AGENTS.md load at session start).
    2. Check the harness:    powershell -File '$HarnessRoot\tools\audit.ps1'
    3. Give it a real task. A T2 task should open with the ask widget, not code.

  Repo docs: README.md    Full law: `$HarnessRoot\agent\AGENTS.md`

"@
