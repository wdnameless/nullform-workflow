<#
.SYNOPSIS
    test-portability.ps1 - Narrow behavioral sandbox regression suite for portability & installers.
.DESCRIPTION
    Runs isolated tests in temporary sandbox directory:
    1. Base installer executes with -UserHome and -SkipMcp into empty sandbox:
       - Verifies core files installed without modifying Paseo config.
    2. Paseo integration setup (setup-paseo.ps1):
       - Verifies integration into ~/.paseo/config.json using daemon.agentProfiles schema.
       - Verifies preservation of existing non-owned agentProfiles.
       - Verifies preservation of existing user-chosen model when not forced.
       - Verifies idempotency on repeated execution.
       - Verifies abort and zero data loss on malformed JSON in existing config.
       - Verifies the written config.json has no UTF-8 BOM (EF BB BF), which strict
         JSON parsers reject: asserted on generation, merge, idempotency and -Force paths.
    3. Backward compatibility: deprecated -SkipPaseo remains a no-op that exits 0 and
       leaves Paseo untouched; -SkipPaseo together with -SetupPaseo fails clearly.
#>

$ErrorActionPreference = 'Stop'

function Assert($condition, $message) {
    if (-not $condition) {
        Write-Error "ASSERTION FAILED: $message"
        exit 1
    }
}

# A UTF-8 BOM (EF BB BF) is legal in a file but rejected by strict JSON parsers,
# including the Node/Paseo readers of config.json. Assert the bytes, not the decoded
# text: Get-Content strips the BOM, so a text comparison cannot see this defect.
function Assert-NoBom($path, $label) {
    $bytes = [System.IO.File]::ReadAllBytes($path)
    $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    Assert (-not $hasBom) "$label MUST NOT begin with a UTF-8 BOM (EF BB BF); strict JSON parsers reject it"
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$SandboxDir = Join-Path ([System.IO.Path]::GetTempPath()) ("omp-sandbox-" + [System.Guid]::NewGuid().ToString("N"))

try {
    Write-Host "Creating sandbox at $SandboxDir..."
    New-Item -ItemType Directory -Path $SandboxDir -Force | Out-Null

    $FakeHome = Join-Path $SandboxDir "userhome"
    New-Item -ItemType Directory -Path $FakeHome -Force | Out-Null
    $emptySecretsPath = Join-Path $SandboxDir "empty-secrets.env"
    [System.IO.File]::WriteAllText($emptySecretsPath, "", [System.Text.Encoding]::UTF8)

    # Compute baseline checksums of repo tracked source files to ensure installer is strictly read-only on repo source
    Write-Host "Computing baseline checksums of repo source files..."
    $trackedFiles = Get-ChildItem -Path $RepoRoot -Recurse -File | Where-Object {
        # .opencode is a generated, gitignored index cache (holds a live SQLite DB that
        # cannot be hashed reliably), not tracked source, so it is excluded from the
        # immutability baseline alongside the other generated directories.
        $_.FullName -notmatch '\\(\.git|\.codemap|\.opencode|\.workflow|node_modules|tests\\__tmp__)'
    }
    $baselineHashes = @{}
    foreach ($f in $trackedFiles) {
        $baselineHashes[$f.FullName] = (Get-FileHash -Path $f.FullName -Algorithm SHA256).Hash
    }

    # --- TEST 1: Base installer in sandbox does not touch Paseo or repo source ---
    Write-Host "Running Test 1: Base installer in isolated sandbox..."
    $installScript = Join-Path $RepoRoot "install.ps1"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installScript -UserHome $FakeHome -SecretsFile $emptySecretsPath -SkipMcp -NonInteractive
    $installExit = $LASTEXITCODE
    Assert ($installExit -eq 0) "Base installer failed with exit code $installExit"

    # Assert NO repo source files were modified during installation
    foreach ($kv in $baselineHashes.GetEnumerator()) {
        $currentHash = (Get-FileHash -Path $kv.Key -Algorithm SHA256).Hash
        Assert ($currentHash -eq $kv.Value) "Repo source file '$($kv.Key)' was mutated by install.ps1!"
    }
    Write-Host "Verified all $($baselineHashes.Count) source files remained untouched."
    $installedHarness = Join-Path $FakeHome "omp-workflow"
    Assert (Test-Path $installedHarness) "Installed harness root exists"
    Assert (Test-Path (Join-Path $installedHarness "core\PORTABLE.md")) "core\PORTABLE.md exists in installed harness"
    Assert (Test-Path (Join-Path $installedHarness "paseo\setup-paseo.ps1")) "paseo\setup-paseo.ps1 exists in installed harness"
    # Tools subdirectories are load-bearing: archmap-report.mjs resolves these
    # assets relative to itself, and Node's test runner expects tests/ intact.
    Assert (Test-Path (Join-Path $installedHarness "tools\report\client.core.js")) "tools/report/client.core.js must preserve its directory"
    Assert (Test-Path (Join-Path $installedHarness "tools\report\client.problems.js")) "tools/report/client.problems.js must preserve its directory"
    Assert (Test-Path (Join-Path $installedHarness "tools\report\page.css")) "tools/report/page.css must preserve its directory"
    Assert (Test-Path (Join-Path $installedHarness "tools\tests\archmap-report.test.mjs")) "tools/tests must preserve its directory"
    Assert (Test-Path (Join-Path $installedHarness "templates\workflow\cache-policy.example.json")) "cache policy example must install with templates"
    Assert (Test-Path (Join-Path $installedHarness "templates\design\DESIGN.md")) "design contract template must install"
    Assert (Test-Path (Join-Path $installedHarness "templates\design\examples\good\README.md")) "examples/good skeleton must install"
    Assert (-not (Test-Path (Join-Path $installedHarness "tools\client.core.js"))) "tools/report/client.core.js must not be flattened into tools/"
    Assert (-not (Test-Path (Join-Path $installedHarness "tools\page.css"))) "tools/report/page.css must not be flattened into tools/"

    $oldHome = $env:HOME
    $oldUserProfile = $env:USERPROFILE
    try {
        $env:HOME = $FakeHome
        $env:USERPROFILE = $FakeHome
        $auditOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $installedHarness "tools\audit.ps1") -HarnessRoot $installedHarness -Scope core 2>&1
        $auditExit = $LASTEXITCODE
    } finally {
        $env:HOME = $oldHome
        $env:USERPROFILE = $oldUserProfile
    }
    $auditText = ($auditOutput | Out-String)
    Assert ($auditText -notmatch 'positional parameter') "Installed audit must not crash in Join-Path candidate resolution"
    Assert ($auditText -match 'Harness audit') "Installed audit must reach its report"
    Assert ($auditExit -eq 0) "Fresh installed audit must pass, got exit $auditExit`: $auditText"

    Assert (-not (Test-Path (Join-Path $FakeHome ".paseo\config.json"))) "Base installer MUST NOT create or mutate .paseo\config.json"
    Assert (-not (Test-Path (Join-Path $FakeHome ".omp\agent\mcp.json"))) "-SkipMcp MUST NOT create mcp.json"

    # Compare decoded text exactly, including Unicode and resolved installation paths.
    $slashRoot = $installedHarness.Replace([char]92, [char]47)
    $expectedAgents = (Get-Content (Join-Path $RepoRoot "agent\AGENTS.md") -Raw -Encoding UTF8).Replace('<HARNESS>', $slashRoot)
    foreach ($target in @(
        (Join-Path $installedHarness "agent\AGENTS.md"),
        (Join-Path $FakeHome ".omp\agent\AGENTS.md")
    )) {
        Assert ([string]::Equals((Get-Content $target -Raw -Encoding UTF8), $expectedAgents, [System.StringComparison]::Ordinal)) "Installed AGENTS text must match substituted UTF8 source: $target"
    }
    $expectedOrchestrator = (Get-Content (Join-Path $RepoRoot "agent\agents\orchestrator.md") -Raw -Encoding UTF8).Replace('<HARNESS>', $slashRoot)
    $installedOrchestrator = Get-Content (Join-Path $installedHarness "agent\agents\orchestrator.md") -Raw -Encoding UTF8
    Assert ([string]::Equals($installedOrchestrator, $expectedOrchestrator, [System.StringComparison]::Ordinal)) "Installed orchestrator text must match substituted UTF8 source"
    foreach ($rule in (Get-ChildItem (Join-Path $RepoRoot "rules\*.md") -File)) {
        $expectedRule = (Get-Content $rule.FullName -Raw -Encoding UTF8).Replace('<HARNESS>', $slashRoot)
        foreach ($ruleDir in @(
            (Join-Path $installedHarness "rules"),
            (Join-Path $FakeHome ".omp\agent\rules"),
            (Join-Path $FakeHome ".agents\rules")
        )) {
            $target = Join-Path $ruleDir $rule.Name
            Assert ([string]::Equals((Get-Content $target -Raw -Encoding UTF8), $expectedRule, [System.StringComparison]::Ordinal)) "Installed rule text must match substituted UTF8 source: $target"
        }
    }
    Write-Host "Test 1 PASSED."

    # --- TEST 2: Optional Paseo setup with daemon.agentProfiles schema & required model ---
    Write-Host "Running Test 2: setup-paseo.ps1 creates daemon.agentProfiles with required model..."
    $setupPaseoScript = Join-Path $installedHarness "paseo\setup-paseo.ps1"
    
    # 2a. Adding brand-new profile without -Model and without OMP models.yml must fail (never writes placeholder)
    $noModelExit = 0
    try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $setupPaseoScript -UserHome $FakeHome
        $noModelExit = $LASTEXITCODE
    } catch {
        $noModelExit = 1
    }
    Assert ($noModelExit -ne 0) "setup-paseo.ps1 must fail when adding new profile without a model specified"

    # 2b. Providing explicit model succeeds
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $setupPaseoScript -UserHome $FakeHome -Model "my-org/my-model:latest"
    
    $paseoConfigPath = Join-Path $FakeHome ".paseo\config.json"
    Assert (Test-Path $paseoConfigPath) "Paseo config file was created"
    
    $parsed = Get-Content -Raw -Encoding UTF8 $paseoConfigPath | ConvertFrom-Json
    Assert ($null -ne $parsed.daemon) "daemon property exists in config.json"
    Assert ($null -ne $parsed.daemon.agentProfiles) "daemon.agentProfiles exists in config.json"
    Assert ($parsed.daemon.agentProfiles.Count -ge 1) "daemon.agentProfiles contains installed profile(s)"
    $firstProfile = $parsed.daemon.agentProfiles | Where-Object { $_.id -eq "agent_profile_orchestrator" }
    Assert ($firstProfile.model -eq "my-org/my-model:latest") "Explicit model was assigned without placeholders"
    Assert ($firstProfile.model -ne "my-provider/default") "Placeholder 'my-provider/default' MUST NEVER be written"
    Assert-NoBom $paseoConfigPath "Generated Paseo config"
    Write-Host "Test 2 PASSED."

    # --- TEST 3: Preservation of existing unrelated profiles and custom model ---
    Write-Host "Running Test 3: setup-paseo.ps1 preserves unrelated profiles & custom model..."
    # Prepare config with an unrelated custom profile and a user-customized model on the orchestrator profile
    $testConfig = [ordered]@{
        daemon = [ordered]@{
            port = 4567
            agentProfiles = @(
                [ordered]@{
                    id = "unrelated_user_profile"
                    name = "Custom Bot"
                    model = "custom-vendor/special-model"
                },
                [ordered]@{
                    id = "agent_profile_orchestrator"
                    name = "Orchestrator"
                    model = "user-override/gpt-4o"
                    customNote = "KeepMe"
                }
            )
        }
    }
    $jsonContent = $testConfig | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($paseoConfigPath, $jsonContent, [System.Text.Encoding]::UTF8)

    # Run setup-paseo.ps1 without -Force
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $setupPaseoScript -UserHome $FakeHome
    $updated = Get-Content -Raw -Encoding UTF8 $paseoConfigPath | ConvertFrom-Json
    
    $unrelated = $updated.daemon.agentProfiles | Where-Object { $_.id -eq "unrelated_user_profile" }
    Assert ($null -ne $unrelated) "Unrelated profile is preserved"
    Assert ($unrelated.model -eq "custom-vendor/special-model") "Unrelated profile model preserved"
    
    $orch = $updated.daemon.agentProfiles | Where-Object { $_.id -eq "agent_profile_orchestrator" }
    Assert ($null -ne $orch) "Orchestrator profile present"
    Assert ($orch.model -eq "user-override/gpt-4o") "User customized model preserved when -Force omitted"
    Assert ($updated.daemon.port -eq 4567) "daemon.port and other daemon settings preserved"
    Assert-NoBom $paseoConfigPath "Merged Paseo config"
    Write-Host "Test 3 PASSED."

    # --- TEST 4: Idempotency ---
    Write-Host "Running Test 4: setup-paseo.ps1 is idempotent..."
    $contentBefore = Get-Content -Raw -Encoding UTF8 $paseoConfigPath
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $setupPaseoScript -UserHome $FakeHome
    $contentAfter = Get-Content -Raw -Encoding UTF8 $paseoConfigPath
    Assert ($contentBefore -eq $contentAfter) "setup-paseo.ps1 produces identical output on repeated runs"
    Assert-NoBom $paseoConfigPath "Idempotent Paseo config"
    Write-Host "Test 4 PASSED."

    # --- TEST 5: Malformed JSON aborts and does not overwrite existing file ---
    Write-Host "Running Test 5: Malformed JSON aborts safely..."
    $corruptContent = "{ this is : not valid json, definitely syntax error"
    [System.IO.File]::WriteAllText($paseoConfigPath, $corruptContent, [System.Text.Encoding]::UTF8)
    
    $exitCode = 0
    try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $setupPaseoScript -UserHome $FakeHome
        $exitCode = $LASTEXITCODE
    } catch {
        $exitCode = 1
    }
    Assert ($exitCode -ne 0) "setup-paseo.ps1 must fail with non-zero exit code on malformed JSON"
    
    $contentAfterFail = Get-Content -Raw -Encoding UTF8 $paseoConfigPath
    Assert ($contentAfterFail -eq $corruptContent) "Malformed file MUST NOT be overwritten or corrupted"
    Write-Host "Test 5 PASSED."

    # --- TEST 6: Legacy profile equivalence (agent_profile_lean_router_01 / provider=omp / Orchestrator) ---
    Write-Host "Running Test 6: Legacy Paseo profile recognized and not duplicated..."
    $legacyConfig = @{
        daemon = @{
            agentProfiles = @(
                @{
                    id = "agent_profile_lean_router_01"
                    name = "Orchestrator"
                    provider = "omp"
                    model = "custom-host/legacy-model"
                    notes = "Legacy profile preserved"
                }
            )
        }
    }
    $legacyJson = $legacyConfig | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($paseoConfigPath, $legacyJson, [System.Text.Encoding]::UTF8)

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $setupPaseoScript -UserHome $FakeHome
    $updatedLegacy = Get-Content -Raw -Encoding UTF8 $paseoConfigPath | ConvertFrom-Json
    $legacyProf = $updatedLegacy.daemon.agentProfiles | Where-Object { $_.id -eq "agent_profile_lean_router_01" }
    Assert ($null -ne $legacyProf) "Legacy equivalent profile is preserved"
    Assert ($legacyProf.model -eq "custom-host/legacy-model") "Legacy equivalent model is untouched"
    $duplicateOrch = $updatedLegacy.daemon.agentProfiles | Where-Object { $_.id -eq "agent_profile_orchestrator" }
    Assert ($null -eq $duplicateOrch) "New orchestrator profile is not duplicated when legacy equivalent is present"
    Write-Host "Test 6 PASSED."

    # --- TEST 7: Installer with -SetupPaseo merges profiles and preserves settings ---
    Write-Host "Running Test 7: Installer with -SetupPaseo using isolated fake secrets..."
    $fakeSecretsPath = Join-Path $SandboxDir "fake-secrets.env"
    $fakeSecretsContent = "PROVIDER_BASE_URL=https://api.openai.com/v1`nPROVIDER_API_KEY=test-key-12345`nDEFAULT_MODEL_ID=gpt-4o"
    [System.IO.File]::WriteAllText($fakeSecretsPath, $fakeSecretsContent, [System.Text.Encoding]::UTF8)

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installScript -UserHome $FakeHome -SecretsFile $fakeSecretsPath -SkipMcp -NonInteractive -SetupPaseo
    $installPaseoExit = $LASTEXITCODE
    Assert ($installPaseoExit -eq 0) "Installer with -SetupPaseo succeeded with exit 0"
    $paseoFinal = Get-Content -Raw -Encoding UTF8 $paseoConfigPath | ConvertFrom-Json
    $finalProf = $paseoFinal.daemon.agentProfiles | Where-Object { $_.id -eq "agent_profile_lean_router_01" }
    Assert ($null -ne $finalProf) "Legacy profile still preserved after full installer run"
    Assert ($finalProf.model -eq "custom-host/legacy-model") "Legacy profile model untouched"
    Assert-NoBom $paseoConfigPath "Installer-driven Paseo config"
    Write-Host "Test 7 PASSED."

    # --- TEST 8: setup-paseo -Force merges canonical template while preserving user model when not specified ---
    Write-Host "Running Test 8: setup-paseo -Force with legacy equivalent..."
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $setupPaseoScript -UserHome $FakeHome -Force
    $forceLegacyConfig = Get-Content -Raw -Encoding UTF8 $paseoConfigPath | ConvertFrom-Json
    $forceLegacyProf = $forceLegacyConfig.daemon.agentProfiles | Where-Object { $_.id -eq "agent_profile_lean_router_01" }
    Assert ($null -ne $forceLegacyProf) "Legacy profile exists after -Force"
    Assert ($forceLegacyProf.model -eq "custom-host/legacy-model") "Legacy profile model preserved after -Force"
    Assert-NoBom $paseoConfigPath "Force-refreshed Paseo config"
    Write-Host "Test 8 PASSED."

    # --- TEST 9: Noninteractive reinstall preserves existing MCP and Paseo configs ---
    Write-Host "Running Test 9: Noninteractive reinstall preserves existing user configs..."
    $mcpPath = Join-Path $FakeHome ".omp\agent\mcp.json"
    $mcpSentinel = "{`r`n  `"mcpServers`": {},`r`n  `"sentinel`": `"keep-user-config`"`r`n}`r`n"
    [System.IO.File]::WriteAllText($mcpPath, $mcpSentinel, [System.Text.Encoding]::UTF8)
    $mcpHashBefore = (Get-FileHash -Path $mcpPath -Algorithm SHA256).Hash
    $paseoHashBefore = (Get-FileHash -Path $paseoConfigPath -Algorithm SHA256).Hash
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installScript -UserHome $FakeHome -SecretsFile $emptySecretsPath -NonInteractive
    $reinstallExit = $LASTEXITCODE
    Assert ($reinstallExit -eq 0) "Noninteractive reinstall failed with exit code $reinstallExit"
    Assert ((Get-FileHash -Path $mcpPath -Algorithm SHA256).Hash -eq $mcpHashBefore) "Existing mcp.json MUST remain byte-for-byte unchanged"
    Assert ((Get-FileHash -Path $paseoConfigPath -Algorithm SHA256).Hash -eq $paseoHashBefore) "Base reinstall MUST NOT mutate existing Paseo config"
    Write-Host "Test 9 PASSED."

    # --- TEST 10: Deprecated -SkipPaseo remains accepted and Paseo stays untouched ---
    Write-Host "Running Test 10: Deprecated -SkipPaseo is a no-op and exits 0..."
    $skipPaseoHome = Join-Path $SandboxDir "userhome-skippaseo"
    New-Item -ItemType Directory -Path $skipPaseoHome -Force | Out-Null
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installScript -UserHome $skipPaseoHome -SecretsFile $emptySecretsPath -SkipPaseo -SkipMcp -NonInteractive
    $skipPaseoExit = $LASTEXITCODE
    Assert ($skipPaseoExit -eq 0) "-SkipPaseo MUST still be accepted and exit 0 (backward compatibility), got $skipPaseoExit"
    Assert (-not (Test-Path (Join-Path $skipPaseoHome ".paseo\config.json"))) "-SkipPaseo run MUST NOT create or mutate .paseo\config.json"
    Assert (Test-Path (Join-Path $skipPaseoHome "omp-workflow\core\PORTABLE.md")) "-SkipPaseo run MUST still perform the base install"

    # Contradictory flags must fail clearly instead of silently choosing a precedence.
    $conflictExit = 0
    try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installScript -UserHome $skipPaseoHome -SecretsFile $emptySecretsPath -SkipPaseo -SetupPaseo -SkipMcp -NonInteractive
        $conflictExit = $LASTEXITCODE
    } catch {
        $conflictExit = 1
    }
    Assert ($conflictExit -ne 0) "-SkipPaseo with -SetupPaseo MUST fail clearly (contradictory switches)"
    Assert (-not (Test-Path (Join-Path $skipPaseoHome ".paseo\config.json"))) "Contradictory flags MUST abort before touching Paseo config"
    Write-Host "Test 10 PASSED."

    # --- TEST 11: install -SetupPaseo on a machine with NO existing Paseo config ---
    # Regression: install.ps1 referenced an undefined $configuredModel, so -Model
    # was never forwarded and setup-paseo.ps1 died on a clean machine.
    Write-Host "Running Test 11: Clean -SetupPaseo install forwards model from secrets..."
    $cleanHome = Join-Path $SandboxDir "userhome-cleanpaseo"
    New-Item -ItemType Directory -Path $cleanHome -Force | Out-Null
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installScript -UserHome $cleanHome -SecretsFile $fakeSecretsPath -SkipMcp -NonInteractive -SetupPaseo
    $cleanExit = $LASTEXITCODE
    Assert ($cleanExit -eq 0) "Clean -SetupPaseo install MUST succeed when secrets.env provides DEFAULT_MODEL_ID, got exit $cleanExit"
    $cleanCfg = Get-Content -Raw -Encoding UTF8 (Join-Path $cleanHome ".paseo\config.json") | ConvertFrom-Json
    $cleanProfile = $cleanCfg.daemon.agentProfiles | Where-Object { $_.id -eq "agent_profile_orchestrator" }
    Assert ($null -ne $cleanProfile) "Orchestrator profile must exist after clean -SetupPaseo"
    Assert ($cleanProfile.model -eq "my-provider/gpt-4o") "Profile model must come from secrets (my-provider/gpt-4o), got: $($cleanProfile.model)"

    Write-Host "`nAll 11 portability regression tests PASSED successfully!"


} finally {
    if (Test-Path $SandboxDir) {
        Remove-Item -Recurse -Force $SandboxDir -ErrorAction SilentlyContinue
    }
}
