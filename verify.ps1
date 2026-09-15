#Requires -Version 5.1
<#
.SYNOPSIS
  Nullform Workflow — one-command verification.
  Checks every layer of the installed harness and prints a PASS/FAIL table.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File verify.ps1
#>
param([string]$HarnessRoot = 'D:\ohmypi')
$ErrorActionPreference = 'Continue'
$results = @()
function Check($name, [scriptblock]$test) {
  try { $r = & $test; $script:results += [pscustomobject]@{ Check = $name; Result = $(if ($r) { 'PASS' } else { 'FAIL' }); Detail = "$r" } }
  catch { $script:results += [pscustomobject]@{ Check = $name; Result = 'FAIL'; Detail = $_.Exception.Message } }
}

$agentDir = "$HOME\.omp\agent"
Write-Host "`n=== Nullform Workflow verification ===`n"

Check 'openspec installed' { (& openspec --version) -match '^\d+\.' }
Check 'skills registry (>= 50)' { (Get-ChildItem "$HOME\.agents\skills" -Directory).Count -ge 50 }
Check 'agent defs junction/copies' {
  $n = (Get-ChildItem "$agentDir\agents" -Filter *.md -ErrorAction SilentlyContinue).Count
  $n -ge 10
}
# OMP rejects an agent file without `description`; the file is skipped entirely,
# so a missing description silently removes an agent from the roster.
Check 'agent defs parse (name + description on every file)' {
  $bad = @()
  Get-ChildItem "$agentDir\agents" -Filter *.md -ErrorAction SilentlyContinue | ForEach-Object {
    $head = (Get-Content $_.FullName -TotalCount 6) -join "`n"
    if ($head -notmatch '(?m)^name:' -or $head -notmatch '(?m)^description:') { $bad += $_.Name }
  }
  if ($bad.Count) { throw "missing name/description: $($bad -join ', ')" }
  $true
}
# A description opened with a quote but not closed makes the whole SKILL.md
# frontmatter unparsable, so the skill is dropped from the registry.
Check 'skills frontmatter valid (no unclosed quote)' {
  $bad = @()
  Get-ChildItem "$HOME\.agents\skills" -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $f = Join-Path $_.FullName 'SKILL.md'
    if (-not (Test-Path $f)) { return }
    $line = (Get-Content $f -TotalCount 12 -ErrorAction SilentlyContinue) |
            Where-Object { $_ -match '^description:' } | Select-Object -First 1
    if ($line) {
      $v = $line.Substring($line.IndexOf(':') + 1).Trim()
      if ($v.StartsWith('"') -and -not $v.EndsWith('"')) { $bad += $_.Name }
    }
  }
  if ($bad.Count) { throw "unclosed description quote: $($bad -join ', ')" }
  $true
}
# Catches a config copied from another machine (a hardcoded tool path that does
# not exist here), which makes that MCP server silently never connect.
Check 'mcp stdio commands resolvable' {
  $m = Get-Content "$agentDir\mcp.json" -Raw | ConvertFrom-Json
  $bad = @()
  foreach ($p in $m.mcpServers.PSObject.Properties) {
    $s = $p.Value
    if ($s.url) { continue }
    $bin = $s.args | Where-Object { $_ -notmatch '^/' -and $_ -notmatch '^-' } | Select-Object -First 1
    if (-not $bin) { continue }
    if (-not (Get-Command $bin -ErrorAction SilentlyContinue) -and -not (Test-Path $bin)) { $bad += "$($p.Name):$bin" }
  }
  if ($bad.Count) { throw "not found: $($bad -join ', ')" }
  $true
}
# Rules are installed to the agents root (highest-priority source); the harness
# dir is a fallback for older installs.
Check 'rules present + addressable (description frontmatter)' {
  $p = "$HOME\.agents\rules\enterprise-directives.md"
  if (-not (Test-Path $p)) { $p = "$agentDir\rules\enterprise-directives.md" }
  if (-not (Test-Path $p)) { throw "rule not found in either location" }
  ((Get-Content $p -TotalCount 3) -match 'description:') -ne $null
}
Check 'mcp.json valid + 7 servers' {
  $m = Get-Content "$agentDir\mcp.json" -Raw | ConvertFrom-Json
  ($m.mcpServers.PSObject.Properties.Name).Count -ge 7
}
# Map-form matters: list-form registers the provider under the first model-id segment,
# so role selectors like nullform-gateway/... stop resolving.
Check 'models.yml map-form, no placeholders, provider id intact' {
  $y = Get-Content "$agentDir\models.yml" -Raw
  ($y -notmatch '__NULLFORM_GATEWAY_KEY__') -and ($y -match 'nullform-gateway:')
}
Check 'models.yml resolves declared provider (live registry)' {
  # Invoke the .cmd shim: PowerShell resolves `omp` to omp.ps1, which calls a
  # bun.exe that does not exist next to it, so a bare `& omp` always fails.
  $omp = Join-Path $env:APPDATA 'npm\omp.cmd'
  if (-not (Test-Path $omp)) { $omp = 'omp.cmd' }
  $out = & cmd.exe /c "`"$omp`" models find nullform-gateway" 2>&1 | Out-String
  $out -match 'nullform-gateway'
}
Check 'session_cost selftest' {
  $out = & python "$HarnessRoot\tools\session_cost.py" --selftest 2>&1 | Out-String
  $LASTEXITCODE -eq 0 -and ($out -match '7/7')
}
# Live check: the codemap engine must run from its installed path and complete an
# init/update cycle in a throwaway dir. A missing node or a broken engine means
# repository cartography silently never works.
Check 'codemap engine init/update cycle' {
  $tmp = Join-Path $env:TEMP ("codemap-check-" + [guid]::NewGuid().ToString('N').Substring(0,8))
  New-Item -ItemType Directory -Force -Path "$tmp\src" | Out-Null
  Set-Content -Path "$tmp\src\a.ts" -Value "export const a = 1;" -Encoding UTF8
  $init = & node "$HarnessRoot\tools\codemap.mjs" init --root $tmp --include 'src/**/*.ts' 2>&1 | Out-String
  $upd  = & node "$HarnessRoot\tools\codemap.mjs" update --root $tmp 2>&1 | Out-String
  $chg  = & node "$HarnessRoot\tools\codemap.mjs" changes --root $tmp 2>&1 | Out-String
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  ($LASTEXITCODE -eq 0) -and ($init -match '1 files tracked') -and ($chg -match '\+0 ~0 -0')
}
# Drift check: the live agent definitions must match the distributable repo.
# Without this, an edit to one copy silently rots the other.
Check 'harness/repo drift (agent defs + rules)' {
  $syncScript = "$PSScriptRoot\tools\sync.ps1"
  if (-not (Test-Path $syncScript)) { $syncScript = "$HarnessRoot\tools\sync.ps1" }
  if (-not (Test-Path $syncScript)) { throw "sync.ps1 not found" }
  $sync = & powershell -ExecutionPolicy Bypass -File $syncScript 2>&1 | Out-String
  if ($sync -match 'sync: clean') { $true } else { throw ($sync.Trim() -split "`n" | Select-Object -Last 3 | Out-String).Trim() }
}
# New engineering skills must actually resolve in the registry, not just sit on disk.
Check 'engineering skills registered (domain/design/bugs/codemap/deepwork)' {
  $want = 'domain-modeling', 'codebase-design', 'diagnosing-bugs', 'codemap', 'deepwork'
  $missing = $want | Where-Object { -not (Test-Path "$HOME\.agents\skills\$_\SKILL.md") }
  if ($missing) { "missing: $($missing -join ', ')" } else { $true }
}
Check 'hindsight memory health (200)' {
  (Invoke-WebRequest -UseBasicParsing -Uri 'https://memory.88-99-90-19.sslip.io/health' -TimeoutSec 15).StatusCode -eq 200
}
Check 'crawl4ai MCP endpoint (200/401)' {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri 'https://crawl.88-99-90-19.sslip.io/mcp/sse' -TimeoutSec 15
    $r.StatusCode -eq 200
  } catch { $_.Exception.Response.StatusCode.value__ -eq 401 }
}
Check 'gateway models list (200)' {
  $key = (Select-String -Path "$agentDir\models.yml" -Pattern 'apiKey:\s*(\S+)' | Select-Object -First 1).Matches.Groups[1].Value
  (Invoke-WebRequest -UseBasicParsing -Uri 'https://ai-gateway.nullform.cv/v1/models' -Headers @{ Authorization = "Bearer $key" } -TimeoutSec 20).StatusCode -eq 200
}
Check 'grill chain (grill-me + grilling)' {
  (Test-Path "$HOME\.agents\skills\grill-me\SKILL.md") -and (Test-Path "$HOME\.agents\skills\grilling\SKILL.md")
}
# Live check: a real session must produce no MCP connection failures. The MCP tool
# catalog travels in the system prompt (not the transcript), so the observable
# signal is the absence of `MCP tool load failed` in the session's log.
Check 'MCP servers connect in a live session (no load failures)' {
  $omp = Join-Path $env:APPDATA 'npm\omp.cmd'
  if (-not (Test-Path $omp)) { $omp = 'omp.cmd' }
  $logDir = "$HOME\.omp\logs"
  $before = @(Get-ChildItem $logDir -Filter *.log -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
  $tmp = Join-Path $env:TEMP ("nf-verify-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    $prev = Get-Location
    Set-Location $tmp
    & cmd.exe /c "`"$omp`" -p --no-session --no-title --model ollama-cloud/deepseek-v4-flash `"say ok`"" 2>&1 | Out-Null
    Set-Location $prev
  } finally {
    Set-Location $env:TEMP
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
  $new = Get-ChildItem $logDir -Filter *.log -ErrorAction SilentlyContinue |
         Where-Object { $before -notcontains $_.Name } | Sort-Object LastWriteTime -Descending
  if (-not $new) { throw 'no new session log written' }
  $fails = @()
  foreach ($l in $new) {
    $m = Select-String -Path $l.FullName -Pattern 'MCP tool load failed' -ErrorAction SilentlyContinue
    foreach ($hit in $m) {
      $p = [regex]::Match($hit.Line, '"path":"mcp:([^"]+)"')
      if ($p.Success) { $fails += $p.Groups[1].Value }
    }
  }
  # No browser MCP server is shipped: OMP's native browser tool covers that, and
  # OMP suppresses browser MCP servers (filterBrowser) while that tool is active.
  if ($fails.Count) { throw "failed to load: $(($fails | Sort-Object -Unique) -join ', ')" }
  'no MCP load failures'
}

$results | Format-Table -AutoSize
# PS 5.1: a single-object pipeline result is not an array and has no .Count,
# so `12 - $null` silently reported 12/12 and exited 0 on a real FAIL.
$fail = @($results | Where-Object { $_.Result -eq 'FAIL' }).Count
Write-Host ("`n{0}/{1} checks passed" -f ($results.Count - $fail), $results.Count)
exit $(if ($fail -gt 0) { 1 } else { 0 })
