import io

def apply(p, old, new, label):
    raw = io.open(p, encoding='utf-8', newline='').read()
    eol = '\r\n' if '\r\n' in raw else '\n'
    o = old.replace('\n', eol)
    n = new.replace('\n', eol)
    assert o in raw, f'{label}: anchor not found (eol={eol!r})'
    raw = raw.replace(o, n, 1)
    io.open(p, 'w', encoding='utf-8', newline='').write(raw)
    print(f'{label}: fixed (eol={eol!r})')

# ---------- 1. sync.ps1
apply('tools/sync.ps1',
"""  'templates\\design\\DESIGN.md',
  'templates\\design\\examples\\good\\README.md',
  'templates\\design\\examples\\bad\\README.md',""",
"""  'templates\\design\\DESIGN.md',
  'templates\\design\\examples\\good\\README.md',
  'templates\\design\\examples\\bad\\README.md',
  'templates\\ci\\workflow-gate.yml',
  'templates\\workflow\\cache-policy.example.json',
  'templates\\paseo.json',""",
'sync-manifest')

apply('tools/sync.ps1',
"""  $drift += $rel
  if ($Promote) {
    Write-Normalized $repoPath $live
    Write-Host "  [->] promote $rel" -ForegroundColor Cyan
  } elseif ($Deploy) {""",
"""  $drift += $rel
  if ($Promote) {
    # Promote writes live -> repo. If the repo copy is NEWER than the live copy,
    # that write destroys newer work: collect it and skip (unless -Force).
    $liveTime = (Get-Item -LiteralPath $livePath -ErrorAction SilentlyContinue).LastWriteTimeUtc
    $repoTime = (Get-Item -LiteralPath $repoPath -ErrorAction SilentlyContinue).LastWriteTimeUtc
    if (-not $Force -and $repoTime -and $liveTime -and $repoTime -gt $liveTime) {
      $suspect += $rel
      continue
    }
    Write-Normalized $repoPath $live
    Write-Host "  [->] promote $rel" -ForegroundColor Cyan
  } elseif ($Deploy) {""",
'sync-suspect')

apply('tools/sync.ps1',
"""if ($Promote -and $suspect.Count) {
  Write-Host "sync: REFUSED - $($suspect.Count) repo file(s) are NEWER than the live tree:" -ForegroundColor Red
  foreach ($x in $suspect) { Write-Host "  $x" -ForegroundColor Red }
  Write-Host ""
  Write-Host "Promoting would overwrite that work with a stale harness. Either:" -ForegroundColor Yellow
  Write-Host "  -Deploy      push the repo (newer) INTO the live tree, or" -ForegroundColor Yellow
  Write-Host "  -Promote -Force   if the live tree really is the intended source" -ForegroundColor Yellow
  if (-not $Force) { exit 2 }
}""",
"""if ($Promote -and $suspect.Count) {
  if (-not $Force) {
    Write-Host "sync: REFUSED - $($suspect.Count) repo file(s) are NEWER than the live tree:" -ForegroundColor Red
    foreach ($x in $suspect) { Write-Host "  $x" -ForegroundColor Red }
    Write-Host ""
    Write-Host "Promoting would overwrite that work with a stale harness. Either:" -ForegroundColor Yellow
    Write-Host "  -Deploy      push the repo (newer) INTO the live tree, or" -ForegroundColor Yellow
    Write-Host "  -Promote -Force   if the live tree really is the intended source" -ForegroundColor Yellow
    exit 2
  } else {
    Write-Host "sync: FORCED - overwrote $($suspect.Count) newer repo file(s) with the live tree:" -ForegroundColor Yellow
    foreach ($x in $suspect) { Write-Host "  $x" -ForegroundColor Yellow }
  }
}""",
'sync-guard')

# ---------- 2. install.ps1
apply('install.ps1',
"""    if ($target -ne "$HarnessRoot\\agent\\agents") {
      Remove-Item $junction -Force -Recurse
      New-Item -ItemType Junction -Path $junction -Target "$HarnessRoot\\agent\\agents" | Out-Null""",
"""    if ($target -ne "$HarnessRoot\\agent\\agents") {
      # Remove ONLY the junction reparse point: PS 5.1 Remove-Item -Recurse can
      # traverse a junction and delete the TARGET directory's contents.
      [System.IO.Directory]::Delete($junction, $false)
      New-Item -ItemType Junction -Path $junction -Target "$HarnessRoot\\agent\\agents" | Out-Null""",
'install-junction')

apply('install.ps1',
"foreach ($f in 'verify.ps1', 'audit.ps1', 'README.md', 'CONTEXT.md', 'secrets.example.env') {",
"foreach ($f in 'verify.ps1', 'README.md', 'CONTEXT.md', 'secrets.example.env') {",
'install-filelist')

# ---------- 3. verify.ps1
apply('verify.ps1',
"""Check 'declared provider resolves in the live registry' {
  $y = Get-Content "$agentDir\\models.yml" -Raw
  # First indented key under `providers:` is the provider id.
  # Skip blank lines and comments between 'providers:' and the first key.
  if (-not (Test-Path "$agentDir\\models.yml")) { throw [NotConfigured]::new("no provider yet - re-run install.ps1 with a base URL + key + model id") }""",
"""Check 'declared provider resolves in the live registry' {
  if (-not (Test-Path "$agentDir\\models.yml")) { throw [NotConfigured]::new("no provider yet - re-run install.ps1 with a base URL + key + model id") }
  $y = Get-Content "$agentDir\\models.yml" -Raw
  # First indented key under `providers:` is the provider id.
  # Skip blank lines and comments between 'providers:' and the first key.""",
'verify-order')

# ---------- 4. skills-doctor.mjs
apply('tools/skills-doctor.mjs',
"""      if (iSha !== rSha) {
        const truncated = norm(repoText).startsWith(norm(text).trimEnd()) || norm(text).length < norm(repoText).length * 0.9;
        problems.push({
          skill: name,
          kind: truncated ? "truncation" : "parity",
          detail: truncated
            ? `installed copy looks TRUNCATED (${norm(text).length} vs ${norm(repoText).length} bytes)`
            : `installed copy differs from repo (${iSha} vs ${rSha})`,
        });
      }""",
"""      if (iSha !== rSha) {
        // Compare the SAME normalised text used for hashing; raw text carries
        // the resolved harness path and would misfire the truncation heuristic.
        const instNorm = norm(normaliseInstalled(text));
        const truncated = norm(repoText).startsWith(instNorm.trimEnd()) || instNorm.length < norm(repoText).length * 0.9;
        problems.push({
          skill: name,
          kind: truncated ? "truncation" : "parity",
          detail: truncated
            ? `installed copy looks TRUNCATED (${instNorm.length} vs ${norm(repoText).length} bytes)`
            : `installed copy differs from repo (${iSha} vs ${rSha})`,
        });
      }""",
'skills-doctor-norm')

# ---------- 5. session_cost.py
apply('tools/session_cost.py',
'                    is_zero_usage = (inp_val == 0 and out_val == 0 and cr_val == 0) or msg.get("stopReason") == "error"',
"""                    # Classification by actual token usage: an errored turn that
                    # still spent tokens is a real (cold/warm) turn, not zero-usage.
                    # Mixing both made zeroUsageTurns overlap the token totals.
                    is_zero_usage = (inp_val == 0 and out_val == 0 and cr_val == 0)""",
'session-cost-classify')

# ---------- 6. test-portability.ps1
apply('tests/test-portability.ps1',
"""    $duplicateOrch = $updatedConfig.daemon.agentProfiles | Where-Object { $_.id -eq "agent_profile_orchestrator" }
    Assert ($null -eq $duplicateOrch) "New orchestrator profile is not duplicated when legacy equivalent is present\"""",
"""    $orchCount = @($updatedConfig.daemon.agentProfiles | Where-Object { $_.id -eq "agent_profile_orchestrator" }).Count
    Assert ($orchCount -eq 0) "New orchestrator profile is not duplicated when legacy equivalent is present (count=$orchCount)\"""",
'test6-count')

# ---------- 7. AGENTS.md
apply('agent/AGENTS.md',
"Also available: `@sonic` (mechanical edits/data collection), `@security-reviewer`\n(read-only security audit). `task` is the default spawn type, not a named role.",
"Also available: `@reviewer` (adversarial code review), `@sonic` (mechanical edits/\ndata collection), `@security-reviewer` (read-only security audit). `task` is the\ndefault spawn type, not a named role.",
'agents-roster')
