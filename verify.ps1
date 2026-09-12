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

Write-Host "`n=== Nullform Workflow verification ===`n"

Check 'openspec installed' { (& openspec --version) -match '^\d+\.' }
Check 'skills registry (>= 50)' { (Get-ChildItem "$HOME\.agents\skills" -Directory).Count -ge 50 }
Check 'agent defs junction/copies' { (Get-ChildItem "$HarnessRoot\agent\agents" -Filter *.md).Count -ge 10 }
Check 'rules present' { Test-Path "$HOME\.agents\rules\enterprise-directives.md" }
Check 'mcp.json valid + 8 servers' {
  $m = Get-Content "$HarnessRoot\agent\mcp.json" -Raw | ConvertFrom-Json
  ($m.mcpServers.PSObject.Properties.Name).Count -ge 8
}
Check 'models.yml valid, no placeholders' {
  $y = Get-Content "$HarnessRoot\agent\models.yml" -Raw
  ($y -notmatch '__NULLFORM_GATEWAY_KEY__') -and ($y -match 'nullform-gateway')
}
Check 'session_cost selftest' {
  $out = & python "$HarnessRoot\tools\session_cost.py" --selftest 2>&1
  $LASTEXITCODE -eq 0 -and ($out -match '7/7')
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
  $key = (Select-String -Path "$HarnessRoot\agent\models.yml" -Pattern 'apiKey:\s*(\S+)' | Select-Object -First 1).Matches.Groups[1].Value
  (Invoke-WebRequest -UseBasicParsing -Uri 'https://ai-gateway.nullform.cv/v1/models' -Headers @{ Authorization = "Bearer $key" } -TimeoutSec 20).StatusCode -eq 200
}
Check 'grill chain (grill-me + grilling)' {
  (Test-Path "$HOME\.agents\skills\grill-me\SKILL.md") -and (Test-Path "$HOME\.agents\skills\grilling\SKILL.md")
}
Check 'project-test-safety skill' { Test-Path "$HOME\.agents\skills\project-test-safety\SKILL.md" }

$results | Format-Table -AutoSize
$fail = ($results | Where-Object Result -eq 'FAIL').Count
Write-Host ("`n{0}/{1} checks passed" -f ($results.Count - $fail), $results.Count)
exit $(if ($fail) { 1 } else { 0 })
