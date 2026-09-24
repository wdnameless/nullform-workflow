# Regression: sync.ps1 -Promote data-loss guard
#
# The guard refuses -Promote when a repo file is NEWER than its live copy
# (promoting would overwrite newer work with a stale harness). An earlier
# version of sync.ps1 declared $suspect but never populated it, so the guard
# was dead code. This test builds two minimal trees and proves the refusal,
# the skip (repo file untouched), and the -Force override.

$ErrorActionPreference = 'Stop'

function Assert($condition, $message) {
    if (-not $condition) { Write-Error "ASSERTION FAILED: $message"; exit 1 }
}

$Sandbox = Join-Path ([System.IO.Path]::GetTempPath()) ("sync-guard-" + [System.Guid]::NewGuid().ToString('N'))
try {
    $repo = Join-Path $Sandbox 'repo'
    $live = Join-Path $Sandbox 'live'
    New-Item -ItemType Directory -Force -Path (Join-Path $repo 'tools'), (Join-Path $repo 'agent'), $live | Out-Null

    # Minimal repo markers so Resolve-RepoRoot accepts the tree.
    Copy-Item (Join-Path $PSScriptRoot '..\tools\sync.ps1') (Join-Path $repo 'tools\sync.ps1')
    Set-Content -Path (Join-Path $repo 'install.ps1') -Value '# marker' -Encoding UTF8
    Set-Content -Path (Join-Path $repo 'agent\models.yml.example') -Value '# marker' -Encoding UTF8

    # Drift fixture on a plain manifest entry: CONTEXT.md
    $liveFile = Join-Path $live 'CONTEXT.md'
    $repoFile = Join-Path $repo 'CONTEXT.md'
    Set-Content -Path $liveFile -Value 'live version' -Encoding UTF8
    Start-Sleep -Milliseconds 1100
    Set-Content -Path $repoFile -Value 'repo version (newer)' -Encoding UTF8

    $sync = Join-Path $repo 'tools\sync.ps1'
    $fakeAgents = Join-Path $Sandbox 'agents'
    New-Item -ItemType Directory -Force -Path $fakeAgents | Out-Null

    # 1. Plain -Promote must REFUSE and must not touch the newer repo file.
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $sync -HarnessRoot $live -AgentsRoot $fakeAgents -Promote 2>&1 | Out-Null
    $refuseExit = $LASTEXITCODE
    Assert ($refuseExit -eq 2) "Plain -Promote over newer repo file must exit 2, got $refuseExit"
    $repoAfter = (Get-Content $repoFile -Raw).Trim()
    Assert ($repoAfter -eq 'repo version (newer)') "Refused -Promote must leave the newer repo file untouched, got: $repoAfter"

    # 2. -Promote -Force must overwrite and exit 0.
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $sync -HarnessRoot $live -AgentsRoot $fakeAgents -Promote -Force 2>&1 | Out-Null
    $forceExit = $LASTEXITCODE
    Assert ($forceExit -eq 0) "-Promote -Force must exit 0, got $forceExit"
    $repoForced = (Get-Content $repoFile -Raw).Trim()
    Assert ($repoForced -eq 'live version') "Forced promote must overwrite with live content, got: $repoForced"

    # 3. -Prune (dry run): lists harness files absent from the repo, deletes nothing.
    Copy-Item (Join-Path $PSScriptRoot '..\tools\sync-prune.mjs') (Join-Path $repo 'tools\sync-prune.mjs')
    New-Item -ItemType Directory -Force -Path (Join-Path $live 'tools\node_modules\pkg') | Out-Null
    Set-Content -Path (Join-Path $live 'tools\orphan.mjs')     -Value 'harness only' -Encoding UTF8
    Set-Content -Path (Join-Path $live 'tools\keep.mjs')       -Value 'tracked' -Encoding UTF8
    Set-Content -Path (Join-Path $repo 'tools\keep.mjs')       -Value 'tracked' -Encoding UTF8
    Set-Content -Path (Join-Path $live 'tools\node_modules\pkg\old.js') -Value 'never pruned' -Encoding UTF8
    Set-Content -Path (Join-Path $live 'tools\local.json')     -Value '{"config":true}' -Encoding UTF8

    $pruneOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $sync -HarnessRoot $live -AgentsRoot $fakeAgents -Prune 2>&1
    $pruneExit = $LASTEXITCODE
    $pruneText = ($pruneOut | Out-String)
    Assert ($pruneExit -eq 0) "-Prune dry run must exit 0, got $pruneExit"
    Assert ($pruneText -match 'prune: 1 candidate\(s\)') "dry run must report exactly one candidate, got: $pruneText"
    Assert ($pruneText -match 'tools/orphan\.mjs') "candidate list must name the orphan, got: $pruneText"
    Assert (Test-Path (Join-Path $live 'tools\orphan.mjs')) "dry run must not delete anything"

    # 4. -Prune -Confirm deletes the candidate and leaves tracked/protected files alone.
    $confirmOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $sync -HarnessRoot $live -AgentsRoot $fakeAgents -Prune -Confirm 2>&1
    $confirmExit = $LASTEXITCODE
    Assert ($confirmExit -eq 0) "-Prune -Confirm must exit 0, got $confirmExit"
    Assert (-not (Test-Path (Join-Path $live 'tools\orphan.mjs'))) "confirmed prune must delete the orphan"
    Assert (Test-Path (Join-Path $live 'tools\keep.mjs')) "tracked file must survive prune"
    Assert (Test-Path (Join-Path $live 'tools\node_modules\pkg\old.js')) "node_modules must never be pruned"
    Assert (Test-Path (Join-Path $live 'tools\local.json')) "config json must never be pruned"

    # 5. Check mode: absent repo skills reports parity UNVERIFIED and exits 1 (cannot produce green).
    Copy-Item (Join-Path $PSScriptRoot '..\tools\skills-doctor.mjs') (Join-Path $repo 'tools\skills-doctor.mjs')
    Set-Content -Path (Join-Path $repo 'CONTEXT.md') -Value 'live version' -Encoding UTF8
    $checkAbsentOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $sync -HarnessRoot $live -AgentsRoot $fakeAgents 2>&1
    $checkAbsentExit = $LASTEXITCODE
    $checkAbsentText = ($checkAbsentOut | Out-String)
    Assert ($checkAbsentExit -eq 1) "Check with absent repo skills must exit 1, got $checkAbsentExit"
    Assert ($checkAbsentText -match 'parity UNVERIFIED') "Check with absent repo skills must report parity UNVERIFIED, got: $checkAbsentText"

    # 6. Check mode: installed skill drift reports drift and exits 1.
    $skillFixture = @"
---
name: test-skill
description: "Test skill"
---
Body
"@
    New-Item -ItemType Directory -Force -Path (Join-Path $repo 'skills\test-skill'), (Join-Path $fakeAgents 'skills\test-skill') | Out-Null
    Set-Content -Path (Join-Path $repo 'skills\test-skill\SKILL.md') -Value $skillFixture -Encoding UTF8
    Set-Content -Path (Join-Path $fakeAgents 'skills\test-skill\SKILL.md') -Value ($skillFixture + "`n# Drifted modification`n") -Encoding UTF8

    $checkDriftOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $sync -HarnessRoot $live -AgentsRoot $fakeAgents 2>&1
    $checkDriftExit = $LASTEXITCODE
    $checkDriftText = ($checkDriftOut | Out-String)
    Assert ($checkDriftExit -eq 1) "Check with drifted skill must exit 1, got $checkDriftExit"
    Assert ($checkDriftText -match 'skills[\\/]test-skill') "Check output must name drifted skill, got: $checkDriftText"
    Assert ($checkDriftText -match 'DRIFT') "Check output must report DRIFT, got: $checkDriftText"

    # 7. Deploy mode: reports explicit parity without auto-copying skills or resurrecting disabled skills.
    $disabledSkillFixture = @"
---
name: disabled-skill
description: "Disabled skill"
---
Body
"@
    New-Item -ItemType Directory -Force -Path (Join-Path $repo 'skills\disabled-skill') | Out-Null
    Set-Content -Path (Join-Path $repo 'skills\disabled-skill\SKILL.md') -Value $disabledSkillFixture -Encoding UTF8
    Set-Content -Path (Join-Path $fakeAgents '.skills-disabled.json') -Value '{"version": 1, "disabled": ["disabled-skill"]}' -Encoding UTF8

    $deployOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $sync -HarnessRoot $live -AgentsRoot $fakeAgents -Deploy 2>&1
    $deployExit = $LASTEXITCODE
    $deployText = ($deployOut | Out-String)
    Assert ($deployExit -eq 0) "Deploy must exit 0, got $deployExit"
    Assert (-not (Test-Path (Join-Path $fakeAgents 'skills\disabled-skill'))) "Deploy must not create disabled skill on disk"
    Assert ($deployText -match 'skills: parity DRIFT') "Deploy report must visibly report DRIFT when skills drift, got: $deployText"
    Assert ($deployText -match 'file deployment complete; skill parity DRIFT') "Deploy report must state file deployment complete rather than false green, got: $deployText"

    # Installer-owned fixture step: installer aligns skills into ~/.agents/skills
    Set-Content -Path (Join-Path $fakeAgents 'skills\test-skill\SKILL.md') -Value $skillFixture -Encoding UTF8

    # Assert -Check VERIFIED/exit0 once installer has aligned skills
    $checkCleanOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $sync -HarnessRoot $live -AgentsRoot $fakeAgents 2>&1
    $checkCleanExit = $LASTEXITCODE
    $checkCleanText = ($checkCleanOut | Out-String)
    Assert ($checkCleanExit -eq 0) "Check after installer sync must exit 0, got: $checkCleanExit"
    Assert ($checkCleanText -match 'skills: parity VERIFIED') "Check must report parity VERIFIED, got: $checkCleanText"
    Assert ($checkCleanText -match 'sync: clean') "Check must report sync: clean, got: $checkCleanText"

    # 8. -Only skills/<skill> runs skill parity check rather than skipping it.
    # Drift test-skill again so a run that executes the check will report drift and exit 1
    Set-Content -Path (Join-Path $fakeAgents 'skills\test-skill\SKILL.md') -Value ($skillFixture + "`n# Drifted modification`n") -Encoding UTF8
    $onlySpecificOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $sync -HarnessRoot $live -AgentsRoot $fakeAgents -Only 'skills/test-skill' 2>&1
    $onlySpecificExit = $LASTEXITCODE
    $onlySpecificText = ($onlySpecificOut | Out-String)
    Assert ($onlySpecificExit -eq 1) "-Only skills/test-skill must execute skills doctor and exit 1 on drift, got $onlySpecificExit"
    Assert ($onlySpecificText -match 'skills[\\/]test-skill') "-Only skills/test-skill must name drifted skill, got: $onlySpecificText"

    # Re-align and assert -Only skills/<skill> exits 0 and reports parity verified
    Set-Content -Path (Join-Path $fakeAgents 'skills\test-skill\SKILL.md') -Value $skillFixture -Encoding UTF8
    $onlyCleanOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $sync -HarnessRoot $live -AgentsRoot $fakeAgents -Only 'skills/test-skill' 2>&1
    $onlyCleanExit = $LASTEXITCODE
    $onlyCleanText = ($onlyCleanOut | Out-String)
    Assert ($onlyCleanExit -eq 0) "-Only skills/test-skill when clean must exit 0, got $onlyCleanExit"
    Assert ($onlyCleanText -match 'skills: parity VERIFIED') "-Only skills/test-skill must report parity VERIFIED, got: $onlyCleanText"

    Write-Host "sync-guard: 8/8 checks passed (refusal + force override + prune dry run + confirmed prune + absent repo + installed drift + deploy parity + -Only skills/<skill>)."
} finally {
    Remove-Item -Recurse -Force $Sandbox -ErrorAction SilentlyContinue
}
