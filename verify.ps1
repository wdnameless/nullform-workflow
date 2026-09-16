#Requires -Version 5.1
<#
.SYNOPSIS
  One-command verification for the installed workflow harness.

.DESCRIPTION
  Checks every layer and prints a PASS/FAIL table. Vendor-neutral throughout:
  it verifies that YOUR configuration is well-formed and that the harness
  mechanics work, not that any particular provider or service exists.

  Exit 0 = all pass, 1 = at least one failure.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File verify.ps1
  powershell -ExecutionPolicy Bypass -File verify.ps1 -HarnessRoot D:\my-harness
#>
param(
  # Default to the tree this script lives in: it is shipped INTO the harness
  # root by install.ps1, so $PSScriptRoot identifies it without any assumption
  # about where the user installed. -HarnessRoot overrides.
  [string]$HarnessRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Continue'
# Locate the harness (must contain agent\AGENTS.md) and, independently, the repo
# clone that carries the canonical skills/ tree. They are usually different dirs.
if (-not $PSScriptRoot) { $PSScriptRoot = (Get-Location).Path }
# $PSScriptRoot is the harness root when this file sits there, or <harness>\tools
# when it does not. Only step up when the parent is actually a harness.
$dirs = New-Object System.Collections.ArrayList
[void]$dirs.Add($PSScriptRoot)
[void]$dirs.Add((Split-Path -Parent $PSScriptRoot))
if (-not (Test-Path (Join-Path $HarnessRoot 'agent\AGENTS.md'))) {
  $hit = $dirs | Where-Object { Test-Path (Join-Path $_ 'agent\AGENTS.md') } | Select-Object -First 1
  if ($hit) { $HarnessRoot = $hit }
}
$selfRoot = $PSScriptRoot
# The repo clone is the tree with install.ps1 + models.yml.example.
$RepoRoot = @(
  $selfRoot,
  (Join-Path $HarnessRoot 'workflow-repo'),          # repo nested inside the harness
  (Join-Path (Split-Path -Parent $HarnessRoot) 'workflow-repo'),  # repo as a sibling
  $HarnessRoot
) | Where-Object { $_ -and (Test-Path (Join-Path $_ 'install.ps1')) } | Select-Object -First 1
if (-not $RepoRoot) { $RepoRoot = $HarnessRoot }
$results = @()
# Thrown when a check cannot run because the user has not configured that part
# yet (no provider, no MCP service). Distinct from FAIL: an unconfigured harness
# is incomplete setup, and reporting it as a defect makes a clean install look
# broken.
class NotConfigured : System.Exception {
  NotConfigured([string]$m) : base($m) {}
}
function Check($name, [scriptblock]$test) {
  try {
    $r = & $test
    $script:results += [pscustomobject]@{ Check = $name; Result = $(if ($r) { 'PASS' } else { 'FAIL' }); Detail = "$r" }
  } catch [NotConfigured] {
    $script:results += [pscustomobject]@{ Check = $name; Result = 'SETUP'; Detail = $_.Exception.Message }
  } catch {
    $script:results += [pscustomobject]@{ Check = $name; Result = 'FAIL'; Detail = $_.Exception.Message }
  }
}

# Run a child process and capture BOTH its exit code and output reliably:
# $LASTEXITCODE is clobbered by intermediate cmdlets, so use Start-Process.
function Invoke-Capture([string]$exe, [string[]]$argsList) {
  $tmp = Join-Path $env:TEMP ("vf-" + [guid]::NewGuid().ToString('N').Substring(0,8))
  $out = "$tmp.out"; $err = "$tmp.err"
  try {
    $p = Start-Process -FilePath $exe -ArgumentList $argsList -NoNewWindow -Wait -PassThru `
         -RedirectStandardOutput $out -RedirectStandardError $err
    $text = ((Get-Content $out -Raw -ErrorAction SilentlyContinue) + (Get-Content $err -Raw -ErrorAction SilentlyContinue))
    return @{ Code = $p.ExitCode; Text = [string]$text }
  } catch {
    return @{ Code = 127; Text = $_.Exception.Message }
  } finally {
    Remove-Item $out, $err -Force -ErrorAction SilentlyContinue
  }
}

$agentDir = "$HOME\.omp\agent"
Write-Host "`n=== Workflow harness verification ==="
Write-Host "  harness : $HarnessRoot"
Write-Host "  agent   : $agentDir`n"

# ---------------------------------------------------------------- toolchain
Check 'node present (harness tools are Node scripts)' {
  $r = Invoke-Capture 'node' @('--version')
  if ($r.Code -ne 0) { throw "node not runnable" }
  $r.Text.Trim()
}

Check 'openspec present (T2 4-Wave protocol)' {
  $r = Invoke-Capture 'openspec' @('--version')
  if ($r.Code -ne 0 -or $r.Text -notmatch '^\d+\.') { throw "openspec not runnable" }
  "openspec $($r.Text.Trim())"
}

# ---------------------------------------------------------------- agent defs
Check 'agent definitions present' {
  $n = (Get-ChildItem "$agentDir\agents" -Filter *.md -ErrorAction SilentlyContinue).Count
  if ($n -lt 10) { throw "only $n agent files (expected >= 10)" }
  "$n roles"
}

# OMP rejects an agent file without `description` and skips it entirely, so a
# missing description silently removes a role from the roster.
Check 'every agent def has name + description' {
  $bad = @()
  Get-ChildItem "$agentDir\agents" -Filter *.md -ErrorAction SilentlyContinue | ForEach-Object {
    $head = Get-Content $_.FullName -TotalCount 8 -ErrorAction SilentlyContinue
    if (-not ($head -match '^name:') -or -not ($head -match '^description:')) { $bad += $_.Name }
  }
  if ($bad.Count) { throw "missing frontmatter: $($bad -join ', ')" }
  $true
}

# ---------------------------------------------------------------- skills
Check 'skills registry populated (>= 20)' {
  $n = (Get-ChildItem "$HOME\.agents\skills" -Directory -ErrorAction SilentlyContinue).Count
  if ($n -lt 20) { throw "only $n skills installed" }
  "$n skills"
}

Check 'skills registry healthy (frontmatter/truncation/parity/orphans)' {
  $r = Invoke-Capture 'node' @("$HarnessRoot\tools\skills-doctor.mjs", '--installed', "$HOME\.agents\skills", '--repo', "$RepoRoot\skills")
  if ($r.Code -ne 0) { throw (($r.Text -split "`n" | Where-Object { $_ -match '\S' } | Select-Object -Last 4) -join ' | ') }
  'healthy'
}

Check 'workflow skills registered' {
  $want = 'grill-me', 'grilling', 'codebase-design', 'diagnosing-bugs', 'domain-modeling', 'codemap', 'deepwork'
  $missing = @($want | Where-Object { -not (Test-Path "$HOME\.agents\skills\$_\SKILL.md") })
  if ($missing.Count) { throw "missing: $($missing -join ', ')" }
  "$($want.Count) present"
}

# ---------------------------------------------------------------- rules
Check 'rule installed and addressable' {
  $p = "$agentDir\rules\enterprise-directives.md"
  if (-not (Test-Path $p)) { $p = "$HOME\.agents\rules\enterprise-directives.md" }
  if (-not (Test-Path $p)) { throw "rule not found" }
  if (-not ((Get-Content $p -TotalCount 3) -match 'description:')) { throw "no description frontmatter (rule:// will not resolve)" }
  $true
}

# ---------------------------------------------------------------- configs
Check 'mcp.json parses, entries well-formed' {
  $p = "$agentDir\mcp.json"
  if (-not (Test-Path $p)) { throw "mcp.json missing" }
  $m = Get-Content $p -Raw | ConvertFrom-Json
  $names = @($m.mcpServers.PSObject.Properties.Name)
  if ($names.Count -eq 0) { throw "no MCP servers configured" }
  $bad = @()
  foreach ($n in $names) {
    $e = $m.mcpServers.$n
    if ($e.url) {
      if ($e.url -match '__[A-Z0-9_]+__') { $bad += "$n(url placeholder)" }
    } elseif (-not $e.command) { $bad += "$n(no command or url)" }
  }
  if ($bad.Count) { throw "malformed: $($bad -join ', ')" }
  "$($names.Count) servers: $($names -join ', ')"
}

# A stdio server launched as `npx <pkg>@latest` re-resolves against the registry
# on every cold start; that extra round-trip is what turns into an intermittent
# "disconnected during initial connection".
Check 'no MCP server pinned to @latest' {
  $m = Get-Content "$agentDir\mcp.json" -Raw | ConvertFrom-Json
  $bad = @()
  foreach ($n in $m.mcpServers.PSObject.Properties.Name) {
    $a = $m.mcpServers.$n.args
    if ($a -and (($a -join ' ') -match '@latest')) { $bad += $n }
  }
  if ($bad.Count) { throw "unpinned: $($bad -join ', ') - pin the version" }
  $true
}

# Map-form matters: list-form registers the provider under the first model-id
# segment instead of its declared name, so role selectors stop resolving.
Check 'models.yml is map-form with no placeholders' {
  $p = "$agentDir\models.yml"
  if (-not (Test-Path $p)) { throw [NotConfigured]::new("no provider yet - re-run install.ps1 with a base URL + key + model id") }
  $y = Get-Content $p -Raw
  $ph = [regex]::Matches($y, '__[A-Z0-9_]+__')
  if ($ph.Count) { throw "placeholders remain: $(($ph | Select-Object -First 3 | ForEach-Object { $_.Value }) -join ', ')" }
  if ($y -notmatch '(?m)^providers:\s*$') { throw "no top-level 'providers:' key (list-form?)" }
  $true
}

Check 'no unsubstituted placeholders across installed configs' {
  $bad = @()
  foreach ($f in 'models.yml', 'mcp.json', 'config.yml') {
    $fp = Join-Path $agentDir $f
    if (Test-Path $fp) {
      $m = [regex]::Matches((Get-Content $fp -Raw), '__[A-Z0-9_]+__')
      if ($m.Count) { $bad += "$f($($m.Count))" }
    }
  }
  if ($bad.Count) { throw "unsubstituted: $($bad -join ', ')" }
  $true
}

# Resolve the provider id declared in models.yml against the LIVE registry, so a
# typo surfaces here instead of as a mystery routing failure mid-task.
Check 'declared provider resolves in the live registry' {
  $y = Get-Content "$agentDir\models.yml" -Raw
  # First indented key under `providers:` is the provider id.
  # Skip blank lines and comments between 'providers:' and the first key.
  if (-not (Test-Path "$agentDir\models.yml")) { throw [NotConfigured]::new("no provider yet - re-run install.ps1 with a base URL + key + model id") }
  $provId = [regex]::Match($y, '(?m)^providers:\s*$(?:\r?\n(?:\s*#.*|\s*)?)*\r?\n(?:\s*#.*\r?\n)*\s{2}([a-z0-9][a-z0-9._-]*):').Groups[1].Value
  if (-not $provId) { throw "cannot read provider id from models.yml" }
  # Invoke the .cmd shim: PowerShell resolves `omp` to omp.ps1, which calls a
  # bun.exe that does not exist next to it, so a bare `& omp` always fails.
  $omp = Join-Path $env:APPDATA 'npm\omp.cmd'
  if (-not (Test-Path $omp)) { $omp = 'omp.cmd' }
  $r = Invoke-Capture 'cmd.exe' @('/c', "`"$omp`" models find $provId")
  if ($r.Text -notmatch [regex]::Escape($provId)) { throw "provider '$provId' not in the live registry" }
  $provId
}

# Reachability is informational, not a gate: a user may install before their
# provider exists, or point at a sandbox. Verify the DECLARATION is complete and
# report reachability without failing the suite on someone else's uptime.
Check 'provider baseUrl declared (reachability informational)' {
  if (-not (Test-Path "$agentDir\models.yml")) { throw [NotConfigured]::new("no provider yet - re-run install.ps1 with a base URL + key + model id") }
  $u = [regex]::Match((Get-Content "$agentDir\models.yml" -Raw), 'baseUrl:\s*(\S+)').Groups[1].Value
  if (-not $u) { throw "no baseUrl declared in models.yml" }
  if ($u -match '__[A-Z0-9_]+__') { throw "baseUrl is still a placeholder" }
  if ($u -notmatch '^https?://') { throw "baseUrl is not an http(s) URL: $u" }
  try { "declared $u (reachable $((Invoke-WebRequest -UseBasicParsing -Uri "$u/models" -TimeoutSec 15).StatusCode))" }
  catch { "declared $u (not reachable from here)" }
}

# ---------------------------------------------------------------- prompt cache
Check 'prompt surfaces have no volatile literals' {
  $r = Invoke-Capture 'node' @("$HarnessRoot\tools\prompt-lint.mjs", 'scan', '--root', $HarnessRoot)
  if ($r.Code -ne 0) { throw 'volatile content in a prompt surface (breaks the provider cache prefix)' }
  'clean'
}

Check 'prompt surfaces match baseline (cache-prefix stable)' {
  $r = Invoke-Capture 'node' @("$HarnessRoot\tools\prompt-lint.mjs", 'check', '--root', $HarnessRoot)
  if ($r.Code -ne 0) { throw 'surfaces drifted - re-run prompt-lint baseline if the edit was intentional' }
  'matches'
}

# ---------------------------------------------------------------- enforcement
# The tier gate is what makes the protocol enforceable. If it is broken or absent,
# every prose rule it backs silently returns to being a suggestion.
Check 'tier gate enforces artifacts (workflow.mjs)' {
  $tmp = Join-Path $env:TEMP ("wf-" + [guid]::NewGuid().ToString('N').Substring(0,8))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    $wf = Join-Path $HarnessRoot 'tools\workflow.mjs'
    if (-not (Test-Path $wf)) { throw "workflow.mjs missing" }
    # T0 must complete with no artifacts.
    $null = Invoke-Capture 'node' @($wf, 'start', '--tier', 'T0', '--task', 'probe', '--root', $tmp)
    $t0 = Invoke-Capture 'node' @($wf, 'check', '--root', $tmp)
    if ($t0.Code -ne 0) { throw "T0 should require no artifacts, got exit $($t0.Code)" }
    # T2 must refuse to complete, and must reject a path that does not exist.
    $null = Invoke-Capture 'node' @($wf, 'start', '--tier', 'T2', '--task', 'probe2', '--force', '--root', $tmp)
    $t2 = Invoke-Capture 'node' @($wf, 'check', '--root', $tmp)
    if ($t2.Code -eq 0) { throw "T2 passed with no artifacts - the gate does not work" }
    $fake = Invoke-Capture 'node' @($wf, 'artifact', '--kind', 'manifest', '--path', 'nope/missing.md', '--root', $tmp)
    if ($fake.Code -eq 0) { throw "a non-existent artifact path was accepted" }
    $close = Invoke-Capture 'node' @($wf, 'close', '--root', $tmp)
    if ($close.Code -eq 0) { throw "an incomplete tier was closed without --force" }
    $forced = Invoke-Capture 'node' @($wf, 'close', '--force', '--reason', 'probe', '--root', $tmp)
    if ($forced.Code -ne 0) { throw "--force --reason should close" }
    'T0 passes, T2 blocks, fake paths rejected, forced close recorded'
  } finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}

# ---------------------------------------------------------------- visibility
# The architecture report is the human's window into their own repo. A broken
# engine means they silently lose it.
Check 'archmap produces a report with graph and findings' {
  $tmp = Join-Path $env:TEMP ("am-" + [guid]::NewGuid().ToString('N').Substring(0,8))
  New-Item -ItemType Directory -Force -Path "$tmp\src" | Out-Null
  try {
    Set-Content -Path "$tmp\src\a.ts" -Value "import { b } from './b';`nexport const a = b;" -Encoding UTF8
    Set-Content -Path "$tmp\src\b.ts" -Value "import { a } from './a';`nexport const b = a;" -Encoding UTF8
    $am = Join-Path $HarnessRoot 'tools\archmap.mjs'
    if (-not (Test-Path $am)) { throw "archmap.mjs missing" }
    $scan = Invoke-Capture 'node' @($am, 'scan', '--root', $tmp)
    if ($scan.Code -ne 0) { throw "scan failed" }
    $html = Join-Path $tmp '.archmap\architecture.html'
    if (-not (Test-Path $html)) { throw "no report written" }
    $c = Get-Content $html -Raw
    if ($c -notmatch '<svg' -or $c -notmatch 'maintainability') { throw "report missing graph or score" }
    $js = Invoke-Capture 'node' @($am, 'json', '--root', $tmp)
    # A planted two-file cycle must be detected.
    if ($js.Text -notmatch '"cycles":\s*1') { throw "planted cycle not detected" }
    'graph + score + cycle detection ok'
  } finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}

# ---------------------------------------------------------------- engines
Check 'codemap engine init/update cycle' {
  $tmp = Join-Path $env:TEMP ("cm-" + [guid]::NewGuid().ToString('N').Substring(0,8))
  New-Item -ItemType Directory -Force -Path "$tmp\src" | Out-Null
  Set-Content -Path "$tmp\src\a.ts" -Value 'export const a = 1;' -Encoding UTF8
  try {
    $i = Invoke-Capture 'node' @("$HarnessRoot\tools\codemap.mjs", 'init', '--root', $tmp, '--include', 'src/**/*.ts')
    $u = Invoke-Capture 'node' @("$HarnessRoot\tools\codemap.mjs", 'update', '--root', $tmp)
    $c = Invoke-Capture 'node' @("$HarnessRoot\tools\codemap.mjs", 'changes', '--root', $tmp)
    if ($i.Text -notmatch '1 files tracked') { throw "init did not track the file: $($i.Text.Trim())" }
    if ($c.Text -notmatch '\+0 ~0 -0') { throw "post-update changes not clean: $($c.Text.Trim())" }
    'init/update/changes ok'
  } finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}

Check 'replay harness detects covered vs uncovered paths' {
  $tmp = Join-Path $env:TEMP ("rp-" + [guid]::NewGuid().ToString('N').Substring(0,8))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    $cass = Join-Path $tmp 'c.json'
    Set-Content -Path $cass -Encoding UTF8 -Value '{"version":1,"recordedAt":"2026-01-01","target":"http://x","interactions":[{"key":"GET /known [-]","request":{"method":"GET","url":"/known"},"response":{"status":200,"body":"{}"}}]}'
    $leak = Join-Path $tmp 'leak.json'
    Set-Content -Path $leak -Encoding UTF8 -Value '{"version":1,"recordedAt":"2026-01-01","interactions":[{"key":"GET /a [-]","request":{"method":"GET","url":"/a"},"response":{"status":200,"body":"{\"token\":\"sk-real-LEAKED1234567890\"}"}}]}'
    $ok = Invoke-Capture 'node' @("$HarnessRoot\tools\replay.mjs", 'verify', '--cassette', $cass)
    $bad = Invoke-Capture 'node' @("$HarnessRoot\tools\replay.mjs", 'verify', '--cassette', $leak)
    if ($ok.Code -ne 0 -or $ok.Text -notmatch 'structurally valid') { throw "valid cassette rejected" }
    if ($bad.Code -eq 0 -or $bad.Text -notmatch 'UNREDACTED') { throw "leaked secret NOT caught" }
    'both detected'
  } finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}

# ---------------------------------------------------------------- drift
# Only meaningful when the harness was installed from a repo clone (the repo
# carries the sync script). A standalone install legitimately has no counterpart.
Check 'harness/repo drift (when a repo clone is present)' {
  # Only meaningful when this harness sits beside the repo it was built from
  # (the repo carries install.ps1 + models.yml.example). A standalone install has
  # no counterpart to drift from, which is not a failure.
  $sync = Join-Path $RepoRoot "tools\sync.ps1"
  if (-not (Test-Path $sync)) { return 'n/a (no sync tool)' }
  if (-not (Test-Path (Join-Path $RepoRoot "install.ps1"))) { return 'n/a (standalone install)' }
  $r = Invoke-Capture 'powershell' @('-ExecutionPolicy', 'Bypass', '-File', $sync, '-HarnessRoot', $HarnessRoot)
  if ($r.Text -match 'sync: clean') { 'clean' }
  elseif ($r.Text -match 'Cannot locate workflow-repo') { 'n/a (no repo clone)' }
  else { throw 'agent defs/rules differ between harness and repo' }
}

# ---------------------------------------------------------------- report
$results | Format-Table -AutoSize
# PS 5.1: a single-object pipeline result is not an array and has no .Count, so
# `N - $null` silently reported all-pass on a real failure.
$fail  = @($results | Where-Object { $_.Result -eq 'FAIL' }).Count
$setup = @($results | Where-Object { $_.Result -eq 'SETUP' }).Count
Write-Host ("`n{0}/{1} checks passed" -f ($results.Count - $fail - $setup), $results.Count)
if ($setup -gt 0) { Write-Host "$setup awaiting configuration - see the SETUP rows above." -ForegroundColor Yellow }
Write-Host ""
exit $(if ($fail -gt 0) { 1 } else { 0 })
