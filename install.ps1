#Requires -Version 5.1
<#
.SYNOPSIS
  OMP workflow harness - one-command installer.

.DESCRIPTION
  Installs an orchestration harness for OMP: agent definitions, rules, skills,
  tools, and portable core specification. Base installation is strictly OMP-native
  and leaves Paseo untouched; optional Paseo profile integration can be run via -SetupPaseo or explicitly via paseo/setup-paseo.ps1. Nothing here is provider-specific
  or machine-specific - you supply your own model endpoint.

  -SkipPaseo is deprecated: it is accepted for compatibility with older installs
  and is a no-op, because the base install already leaves Paseo untouched.
  Passing it together with -SetupPaseo fails with an error.

  Where things land (all OMP-native paths):
    <HarnessRoot>\agent\           agent definitions + tools (the "live tree")
    <HarnessRoot>\agent\agents\    role definitions
    <HarnessRoot>\tools\           codemap / prompt-lint / replay / audit ...
    <HarnessRoot>\core\            portable workflow specification & contracts
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
  # Non-interactive, sandbox root for testing:
  powershell -ExecutionPolicy Bypass -File install.ps1 -UserHome "C:\temp\test-home" -HarnessRoot "C:\temp\test-home\omp-workflow" -NonInteractive
#>
param(
  [string]$SecretsFile = (Join-Path $PSScriptRoot 'secrets.env'),
  [string]$HarnessRoot = "",
  [string]$UserHome = "",
  [string]$UserRoot = "",
  [switch]$NonInteractive,
  [switch]$SetupPaseo,
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

# -SkipPaseo is kept for backward compatibility with the pre-portable installer.
# The base install now leaves Paseo untouched unconditionally, so the switch is a
# no-op; passing it together with -SetupPaseo is a contradiction, not a precedence
# puzzle, and fails loudly instead of silently picking one.
if ($SkipPaseo -and $SetupPaseo) {
  Die "-SkipPaseo and -SetupPaseo contradict each other. Paseo is skipped by default: pass -SetupPaseo alone to opt in."
}
if ($SkipPaseo) {
  Warn "-SkipPaseo is deprecated and now a no-op: the base install leaves Paseo untouched by default."
}

# Resolve UserHome and HarnessRoot (supporting both UserHome and UserRoot alias)
if ([string]::IsNullOrWhiteSpace($UserHome)) {
  if (-not [string]::IsNullOrWhiteSpace($UserRoot)) {
    $UserHome = $UserRoot
  } else {
    $UserHome = $env:USERPROFILE
    if ([string]::IsNullOrWhiteSpace($UserHome)) {
      $UserHome = $HOME
    }
  }
}
if ([string]::IsNullOrWhiteSpace($HarnessRoot)) {
  $HarnessRoot = Join-Path $UserHome 'omp-workflow'
}

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function WriteText([string]$path, [string]$text) {
  $dir = Split-Path -Parent $path
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($path, $text, $Utf8NoBom)   # a BOM makes the first YAML/JSON key unparsable
}

Write-Host "`n=== OMP workflow installer ===`n"
Write-Host "  user home    : $UserHome"
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
  Get-Content $SecretsFile -Encoding UTF8 | ForEach-Object {
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
$agentDir = Join-Path $UserHome ".omp\agent"
$agentsHome = Join-Path $UserHome ".agents"

foreach ($d in @("$HarnessRoot\agent", "$HarnessRoot\agent\agents", "$HarnessRoot\tools",
                 "$HarnessRoot\core", "$HarnessRoot\paseo", "$HarnessRoot\templates",
                 "$HarnessRoot\rules",
                 $agentDir, "$agentDir\rules",
                 "$agentsHome\rules", "$agentsHome\skills")) {
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}

# AGENTS.md ships path-templated so it survives being installed anywhere. Resolve
# <HARNESS> at install time: without this the agent cannot find the full protocol.
$slashRoot = $HarnessRoot.Replace([char]92, [char]47)   # backslash -> forward slash
$agentsText = (Get-Content "$PSScriptRoot\agent\AGENTS.md" -Raw -Encoding UTF8).Replace('<HARNESS>', $slashRoot)
WriteText "$HarnessRoot\agent\AGENTS.md" $agentsText
WriteText "$agentDir\AGENTS.md" $agentsText
# A one-line pointer, so agent defs can be located from any working directory.
WriteText "$agentDir\.harness-root" ("$HarnessRoot" + [Environment]::NewLine)
Copy-Item "$PSScriptRoot\agent\agents\*" "$HarnessRoot\agent\agents\" -Force -Recurse

Copy-Item "$PSScriptRoot\agent\oracle-priority.example.json" "$HarnessRoot\agent\" -Force
# Copy rules directly into HarnessRoot/rules first. NEVER modify source files in PSScriptRoot!
if (Test-Path "$PSScriptRoot\rules") {
  Copy-Item "$PSScriptRoot\rules\*" "$HarnessRoot\rules\" -Force -Recurse
}
# Perform <HARNESS> substitution strictly on destination copies in HarnessRoot
Get-ChildItem "$HarnessRoot\agent\agents\*.md", "$HarnessRoot\rules\*.md" -ErrorAction SilentlyContinue | ForEach-Object {
  $t = Get-Content $_.FullName -Raw -Encoding UTF8
  if ($t -match '<HARNESS>') { WriteText $_.FullName ($t.Replace('<HARNESS>', $slashRoot)) }
}
# Copy tools preserving directory structure.
Get-ChildItem -Path "$PSScriptRoot\tools" -Exclude 'node_modules' | ForEach-Object {
  Copy-Item $_.FullName "$HarnessRoot\tools\" -Force -Recurse
}

# Copy core and paseo
if (Test-Path "$PSScriptRoot\core") {
  Copy-Item "$PSScriptRoot\core\*" "$HarnessRoot\core\" -Force -Recurse
}
if (Test-Path "$PSScriptRoot\paseo") {
  Copy-Item "$PSScriptRoot\paseo\*" "$HarnessRoot\paseo\" -Force -Recurse
}

# Also drop the repo-level scripts into the harness root, so an install made
# without keeping the clone can still verify and audit itself.
foreach ($f in 'verify.ps1', 'README.md', 'CONTEXT.md', 'secrets.example.env') {
  $src = Join-Path $PSScriptRoot $f
  if (Test-Path $src) { Copy-Item $src "$HarnessRoot\$f" -Force }
}
if (Test-Path "$PSScriptRoot\skills") { Copy-Item "$PSScriptRoot\skills" "$HarnessRoot\skills" -Force -Recurse }
if (Test-Path "$PSScriptRoot\templates") { Copy-Item "$PSScriptRoot\templates\*" "$HarnessRoot\templates\" -Force -Recurse }
if (Test-Path "$PSScriptRoot\CONTEXT.md") { Copy-Item "$PSScriptRoot\CONTEXT.md" "$HarnessRoot\CONTEXT.md" -Force }
Ok "agent defs + tools + core -> $HarnessRoot"

# Skills: skip marketplace-lock-managed ones so the install does not desync
# ~/.agents/.skill-lock.json (a lock entry alone is not proof of installation).
$lockPath = "$agentsHome\.skill-lock.json"
$skipSkills = @()
if (Test-Path $lockPath) {
  $lockedNames = @((Get-Content $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json).skills.PSObject.Properties.Name)
  $skipSkills = @($lockedNames | Where-Object { Test-Path "$agentsHome\skills\$_\SKILL.md" })
}
# Skills the operator disabled on purpose (~/.agents/.skills-disabled.json, the
# same registry record tools/skills-doctor.mjs reports as `info: disabled by
# operator`): an install must not resurrect what the operator pruned.
$disabledPath = "$agentsHome\.skills-disabled.json"
$disabledSkills = @()
if (Test-Path $disabledPath) {
  try {
    $disabledSkills = @((Get-Content $disabledPath -Raw -Encoding UTF8 | ConvertFrom-Json).disabled | Where-Object { $_ -is [string] })
  } catch {
    Warn "skills-disabled list unreadable ($disabledPath) - ignored"
  }
}
$copied = 0; $skipped = @(); $disabled = @()
Get-ChildItem "$PSScriptRoot\skills" -Directory | ForEach-Object {
  if ($skipSkills -contains $_.Name) { $skipped += $_.Name; return }
  if ($disabledSkills -contains $_.Name) { $disabled += $_.Name; return }
  Copy-Item $_.FullName "$agentsHome\skills\" -Force -Recurse
  $script:copied++
}
Ok "skills: $copied installed$(if ($skipped) { ", $(($skipped).Count) lock-managed skipped" })$(if ($disabled) { ", $(($disabled).Count) disabled by operator skipped" })"
# <HARNESS> substitution inside installed skills (destination copies only —
# a skill that references the tools by absolute path must work on any machine).
Get-ChildItem "$agentsHome\skills" -Recurse -Filter *.md -ErrorAction SilentlyContinue | ForEach-Object {
  $t = Get-Content $_.FullName -Raw -Encoding UTF8
  if ($t -match '<HARNESS>') { WriteText $_.FullName ($t.Replace('<HARNESS>', $slashRoot)) }
}

# Copy pre-substituted rules from HarnessRoot to agentDir and agentsHome
if (Test-Path "$HarnessRoot\rules") {
  Copy-Item "$HarnessRoot\rules\*" "$agentDir\rules\" -Force -Recurse
  Copy-Item "$HarnessRoot\rules\*" "$agentsHome\rules\" -Force -Recurse -ErrorAction SilentlyContinue
}
Ok "rules -> $agentDir\rules (and ~/.agents\rules)"

# ---------- 4. Provider + model routing ----------
if ($providerBase) {
  WriteText "$agentDir\models.yml" (Patch (Get-Content "$PSScriptRoot\agent\models.yml.example" -Raw -Encoding UTF8))
  Ok "models.yml -> $agentDir\models.yml (provider: my-provider)"

  if (-not (Test-Path "$agentDir\config.yml")) {
    WriteText "$agentDir\config.yml" (Patch (Get-Content "$PSScriptRoot\agent\config.yml.example" -Raw -Encoding UTF8))
    Ok "config.yml installed (roles -> my-provider/$modelId)"
  } else {
    Warn "config.yml already exists -> left untouched. Update its modelRoles to 'my-provider/$modelId' by hand."
  }

  # Autoselect oracle model role (best-effort, never die)
  try {
    $oracleScript = Join-Path $HarnessRoot 'tools\oracle-model.mjs'
    if (Test-Path $oracleScript) {
      & node $oracleScript ensure --probe --config "$agentDir\config.yml" --models "$agentDir\models.yml" 2>$null
      if ($LASTEXITCODE -eq 0) {
        Ok "oracle model role verified"
      } else {
        Warn "oracle model autoselect completed with non-zero exit ($LASTEXITCODE)"
      }
    }
  } catch {
    Warn "oracle model autoselect failed: $($_.Exception.Message)"
  }
} else {
  Warn "models.yml + config.yml skipped (no provider supplied)"
}

# ---------- 5. MCP fleet (optional) ----------
if (-not $SkipMcp) {
  $mcpTarget = "$agentDir\mcp.json"
  $shouldWrite = -not (Test-Path $mcpTarget)
  if (-not $shouldWrite) {
    if ($NonInteractive) {
      Warn "mcp.json exists -> left untouched (delete it to regenerate)"
    } else {
      $ans = Ask "mcp.json already exists - overwrite with the sanitized example? (y/N)" 'n'
      $shouldWrite = $ans -match '^(y|yes)$'
      if (-not $shouldWrite) { Warn "mcp.json left untouched" }
    }
  }
  if ($shouldWrite) {
    $mcp = Patch (Get-Content "$PSScriptRoot\agent\mcp.json.example" -Raw -Encoding UTF8) | ConvertFrom-Json
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
} else { Warn "MCP step skipped (-SkipMcp)" }

# ---------- 6. Agent-defs junction ----------
$junction = "$agentDir\agents"
if (Test-Path $junction) {
  $item = Get-Item $junction -Force
  if ($item.LinkType -eq 'Junction') {
    $target = ($item.Target | Select-Object -First 1)
    if ($target -ne "$HarnessRoot\agent\agents") {
      # Remove ONLY the junction reparse point: PS 5.1 Remove-Item -Recurse can
      # traverse a junction and delete the TARGET directory's contents.
      [System.IO.Directory]::Delete($junction, $false)
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

# ---------- 7. Optional Paseo integration ----------
# Base installer leaves Paseo configuration completely untouched by default.
# Integration is only performed if explicitly requested via -SetupPaseo.
if ($SetupPaseo) {
  $setupScript = Join-Path $PSScriptRoot "paseo\setup-paseo.ps1"
  if (-not (Test-Path $setupScript)) {
    Die "setup-paseo.ps1 not found at $setupScript"
  }
  $paseoArgs = @("-ExecutionPolicy", "Bypass", "-File", $setupScript, "-UserProfileDir", $UserHome)
  # The collected inputs name it $modelId; $configuredModel never existed, so a
  # clean -SetupPaseo install silently dropped -Model and setup-paseo.ps1 died.
  if ($providerBase -and $modelId) {
    $paseoArgs += @("-Model", "my-provider/$modelId")
  }
  & powershell @paseoArgs
  if ($LASTEXITCODE -ne 0) {
    Die "setup-paseo.ps1 failed with exit code $LASTEXITCODE. If configuring a brand-new profile, ensure an explicit model is available."
  }
  Ok "Optional Paseo integration executed via setup-paseo.ps1"
} else {
  Ok "Base install leaves Paseo untouched. To configure Paseo profiles explicitly, run: powershell -File paseo/setup-paseo.ps1"
}

# ---------- 8. Baseline the prompt surfaces ----------
# Records a hash per prompt surface so a later edit is visible as a cache-prefix
# change rather than a silent full-price re-bill.
if (Test-Path "$HarnessRoot\tools\prompt-lint.mjs") {
  # prompt-lint also scans ~/.agents. During a sandbox/custom -UserHome install,
  # Node must resolve the same home we just populated — otherwise the baseline
  # records the operator's real machine and the first installed audit reports
  # every skill as added/removed.
  $oldHome = $env:HOME
  $oldUserProfile = $env:USERPROFILE
  try {
    $env:HOME = $UserHome
    $env:USERPROFILE = $UserHome
    & node "$HarnessRoot\tools\prompt-lint.mjs" baseline --root $HarnessRoot | Out-Null
  } finally {
    $env:HOME = $oldHome
    $env:USERPROFILE = $oldUserProfile
  }
  Ok "prompt-cache baseline recorded"
}

# ---------- 9. Run install doctor ----------
if (Test-Path "$HarnessRoot\tools\doctor.mjs") {
  $doctorOut = & node "$HarnessRoot\tools\doctor.mjs" --harness "$HarnessRoot" --agent-dir "$agentDir" --agents-home "$agentsHome" 2>&1
  $doctorExit = $LASTEXITCODE
  if ($doctorExit -ne 0) {
    Write-Host ""
    Write-Host "install-doctor detected errors in installed harness:" -ForegroundColor Red
    foreach ($line in $doctorOut) {
      if ($line -match 'FAIL') {
        Write-Host "  $line" -ForegroundColor Red
      }
    }
    exit 1
  }
  Ok "install doctor checks passed"
}

Write-Host "`n=== Installed ==="
Write-Host @"

  Next:
    1. Open a NEW OMP session (skills, MCP, and AGENTS.md load at session start).
    2. Check the harness:    powershell -File '$HarnessRoot\tools\audit.ps1'
    3. Optional Paseo setup: powershell -File '$HarnessRoot\paseo\setup-paseo.ps1'
    4. Give it a real task. A T2 task should open with the ask widget, not code.

  Repo docs: README.md    Core spec: `$HarnessRoot\core\PORTABLE.md`    Full law: `$HarnessRoot\agent\AGENTS.md`

"@
