<#
.SYNOPSIS
    setup-paseo.ps1 - Explicit, optional integration script for Paseo profiles.
.DESCRIPTION
    Integrates workflow agent profiles into Paseo config idempotently.
    Updates daemon.agentProfiles in ~/.paseo/config.json.
    Leaves unrelated profiles, existing keys, daemon settings, and user chosen model intact.
    Does NOT start or restart the daemon without explicit permission.
    If config.json contains malformed JSON, execution aborts with error leaving the file UNTOUCHED.
.PARAMETER UserProfileDir
    Override destination user profile directory (default: $env:USERPROFILE)
.PARAMETER UserHome
    Alias for UserProfileDir.
.PARAMETER UserRoot
    Alias for UserProfileDir.
.PARAMETER Model
    Override model to set for newly installed profile(s). If omitted and profile is new, fails actionably.
.PARAMETER HarnessRoot
    Root path of the installed workflow harness. Used to expand <HarnessRoot> in profile notes.
.PARAMETER Force
    Force re-application of owned profile fields while still preserving unrelated profiles.
#>
param(
    [string]$UserProfileDir = "",
    [string]$UserHome = "",
    [string]$UserRoot = "",
    [string]$Model = "",
    [string]$HarnessRoot = "",
    [switch]$Force
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($UserProfileDir)) {
    if (-not [string]::IsNullOrWhiteSpace($UserHome)) {
        $UserProfileDir = $UserHome
    } elseif (-not [string]::IsNullOrWhiteSpace($UserRoot)) {
        $UserProfileDir = $UserRoot
    } else {
        $UserProfileDir = $env:USERPROFILE
        if ([string]::IsNullOrWhiteSpace($UserProfileDir)) {
            $UserProfileDir = $HOME
        }
    }
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProfilesSource = Join-Path $ScriptDir "profiles.json"

if (-not (Test-Path $ProfilesSource)) {
    Write-Error "Source profiles.json not found at $ProfilesSource"
    exit 1
}

# Resolve HarnessRoot for expanding <HarnessRoot> tokens in profile notes
if ([string]::IsNullOrWhiteSpace($HarnessRoot)) {
    $harnessPointer = Join-Path $UserProfileDir ".omp\agent\.harness-root"
    if (Test-Path $harnessPointer) {
        $HarnessRoot = (Get-Content $harnessPointer -Raw -Encoding UTF8).Trim()
    }
    if ([string]::IsNullOrWhiteSpace($HarnessRoot)) {
        $HarnessRoot = Split-Path -Parent $ScriptDir
    }
}
$harnessSlash = $HarnessRoot.Replace([char]92, [char]47).TrimEnd('/')

function Expand-Notes($notesText) {
    if ($notesText -is [string] -and $notesText -match '<HarnessRoot>') {
        return $notesText.Replace('<HarnessRoot>', $harnessSlash)
    }
    return $notesText
}

$PaseoConfigDir = Join-Path $UserProfileDir ".paseo"
if (-not (Test-Path $PaseoConfigDir)) {
    New-Item -ItemType Directory -Path $PaseoConfigDir -Force | Out-Null
}

$PaseoConfigDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($PaseoConfigDir)
$PaseoConfigFile = [System.IO.Path]::Combine($PaseoConfigDir, "config.json")

# JSON must be written without a BOM: .NET Framework's Encoding::UTF8 emits EF BB BF,
# which strict JSON parsers (including some Paseo/Node readers) reject.
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$sourceProfiles = Get-Content -Raw -Encoding UTF8 $ProfilesSource | ConvertFrom-Json

$existingConfig = $null
if (Test-Path $PaseoConfigFile) {
    $raw = Get-Content -Raw -Encoding UTF8 $PaseoConfigFile
    if (-not [string]::IsNullOrWhiteSpace($raw)) {
        try {
            $existingConfig = $raw | ConvertFrom-Json
        } catch {
            Write-Error "Malformed JSON in existing config file $PaseoConfigFile. Aborting to prevent data loss. Original file was left untouched: $_"
            exit 1
        }
    }
}

if ($null -eq $existingConfig) {
    $existingConfig = [pscustomobject]@{}
}

# Ensure daemon object exists
if (-not $existingConfig.PSObject.Properties["daemon"] -or $null -eq $existingConfig.daemon) {
    $existingConfig | Add-Member -NotePropertyName daemon -NotePropertyValue ([pscustomobject]@{}) -Force
}

$existingProfiles = @()
if ($existingConfig.daemon.PSObject.Properties["agentProfiles"] -and ($existingConfig.daemon.agentProfiles -is [System.Collections.IEnumerable])) {
    $existingProfiles = @($existingConfig.daemon.agentProfiles)
}

$ownedIds = @($sourceProfiles | ForEach-Object { $_.id })
$retainedProfiles = @()

function Is-OwnedEquivalent($prof) {
    if ($null -eq $prof) { return $false }
    if ($prof.id -in $ownedIds) { return $true }
    # Recognize legacy or equivalent Paseo profile: provider omp and name Orchestrator
    if ($prof.provider -eq "omp" -and $prof.name -eq "Orchestrator") { return $true }
    return $false
}

foreach ($p in $existingProfiles) {
    $isOwned = Is-OwnedEquivalent $p
    if (-not $isOwned) {
        # Unrelated profile: keep completely untouched
        $retainedProfiles += $p
    } else {
        # Existing owned profile (canonical or legacy equivalent): preserve unless -Force is specified
        if ($Force) {
            $matchingSource = $sourceProfiles | Where-Object { $_.id -eq $p.id } | Select-Object -First 1
            if ($null -eq $matchingSource) {
                $matchingSource = $sourceProfiles | Select-Object -First 1
            }
            $merged = [ordered]@{}
            if ($matchingSource -and $matchingSource.PSObject) {
                foreach ($prop in $matchingSource.PSObject.Properties) {
                    $merged[$prop.Name] = $prop.Value
                }
            }
            # Preserve user's configured model if set and user didn't specify a new -Model
            if ([string]::IsNullOrWhiteSpace($Model)) {
                if ($p.PSObject.Properties["model"] -and -not [string]::IsNullOrWhiteSpace($p.model)) {
                    $merged["model"] = $p.model
                }
            } else {
                $merged["model"] = $Model
            }
            # Expand <HarnessRoot> in notes
            if ($merged.Contains("notes")) {
                $merged["notes"] = Expand-Notes $merged["notes"]
            }
            # Preserve existing identity fields (id, name, provider)
            $merged["id"] = $p.id
            if ($p.PSObject.Properties["name"] -and -not [string]::IsNullOrWhiteSpace($p.name)) {
                $merged["name"] = $p.name
            }
            if ($p.PSObject.Properties["provider"] -and -not [string]::IsNullOrWhiteSpace($p.provider)) {
                $merged["provider"] = $p.provider
            }
            # Preserve any remaining user custom fields
            foreach ($prop in $p.PSObject.Properties) {
                if (-not $merged.Contains($prop.Name)) {
                    $merged[$prop.Name] = $prop.Value
                }
            }
            $retainedProfiles += (New-Object PSObject -Property $merged)
        } else {
            # Without -Force: preserve existing profile entirely (user-defined model, etc.),
            # but expand <HarnessRoot> in notes if present
            if ($p.PSObject.Properties["notes"]) {
                $p.notes = Expand-Notes $p.notes
            }
            $retainedProfiles += $p
        }
    }
}

# Add any new source profiles not already present or represented by an equivalent
$alreadyCovered = $false
foreach ($rp in $retainedProfiles) {
    if (Is-OwnedEquivalent $rp) {
        $alreadyCovered = $true
        break
    }
}

$retainedIds = @($retainedProfiles | ForEach-Object { $_.id })
foreach ($sp in $sourceProfiles) {
    if ($sp.id -notin $retainedIds -and (-not $alreadyCovered)) {
        $targetModel = $Model
        if ([string]::IsNullOrWhiteSpace($targetModel)) {
            Write-Error "Cannot add new profile '$($sp.id)' without a model. Specify -Model <provider/model>. Writing placeholder models is prohibited."
            exit 1
        }
        $newP = [ordered]@{}
        foreach ($prop in $sp.PSObject.Properties) {
            $val = $prop.Value
            if ($prop.Name -eq "notes") {
                $val = Expand-Notes $val
            }
            $newP[$prop.Name] = $val
        }
        $newP["model"] = $targetModel
        $retainedProfiles += (New-Object PSObject -Property $newP)
    }
}

$existingConfig.daemon | Add-Member -NotePropertyName agentProfiles -NotePropertyValue $retainedProfiles -Force

$newJson = $existingConfig | ConvertTo-Json -Depth 30
$tempFile = [System.IO.Path]::Combine($PaseoConfigDir, ("config.json.tmp." + [System.Guid]::NewGuid().ToString("N")))
$backupFile = [System.IO.Path]::Combine($PaseoConfigDir, ("config.json.bak." + [System.Guid]::NewGuid().ToString("N")))
try {
    [System.IO.File]::WriteAllText($tempFile, $newJson, $Utf8NoBom)

    if ($env:PASEO_SETUP_FAILPOINT -eq "before-replace" -or $env:PASEO_SETUP_FAILPOINT -eq "fail") {
        throw "Simulated failure at failpoint: $env:PASEO_SETUP_FAILPOINT"
    }

    if (Test-Path -LiteralPath $PaseoConfigFile) {
        [System.IO.File]::Replace($tempFile, $PaseoConfigFile, $backupFile, $true)
        if (Test-Path -LiteralPath $backupFile) {
            Remove-Item -LiteralPath $backupFile -Force -ErrorAction SilentlyContinue
        }
    } else {
        [System.IO.File]::Move($tempFile, $PaseoConfigFile)
    }
} catch {
    if ((-not (Test-Path -LiteralPath $PaseoConfigFile)) -and (Test-Path -LiteralPath $backupFile)) {
        Move-Item -LiteralPath $backupFile -Destination $PaseoConfigFile -Force -ErrorAction SilentlyContinue
    }
    Write-Error "Failed to update Paseo configuration file $PaseoConfigFile. Original configuration was left untouched: $_"
    throw
} finally {
    if (Test-Path -LiteralPath $tempFile) {
        Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $backupFile) {
        Remove-Item -LiteralPath $backupFile -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "[OK] Paseo configuration updated successfully at: $PaseoConfigFile"
Write-Host "     daemon.agentProfiles updated idempotently. Unrelated profiles and chosen model preserved."
Write-Host "     Note: Paseo daemon was not touched. Run 'paseo daemon reload' or restart daemon if needed."
