# ===========================================================================
#  IG Feed Watcher - prepare windows\installer\stage for the Inno Setup build
#
#  Refreshes the app files inside the installer staging folder from the repo
#  and sanitizes personal data out of the distribution:
#
#   1. Copies the clean app file set (code, hooks, api, skills, windows,
#      docs, examples) from the repo root into stage\ - the same include /
#      exclude rules as HANDOFF-WINDOWS.md phase 2.
#   2. Rewrites stage\groups.json dropping any group named "Photos" - the
#      owner's personal test group must NOT be seeded into recipients'
#      installs. The repo's own groups.json is left untouched (the local
#      dev/live watcher still uses it).
#
#  It NEVER touches stage-only binary assets: node.exe, node_modules\ and
#  .puppeteer-cache\ stay exactly as they are (M2 model - pre-built).
#
#  Usage (from anywhere):
#    powershell -NoProfile -ExecutionPolicy Bypass -File windows\installer\prepare-stage.ps1
#
#  Requires: an existing stage\ folder (create it per HANDOFF-WINDOWS.md
#  phase 2 with portable node.exe + prebuilt node_modules + Chromium) and
#  robocopy (ships with Windows).
# ===========================================================================
$ErrorActionPreference = "Stop"

# Repo root = three parents up from this script (windows\installer\ -> repo)
$RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$Stage = Join-Path $RepoRoot 'windows\installer\stage'
$GroupsJson = Join-Path $Stage 'groups.json'

if (-not (Test-Path $Stage)) {
    Write-Host "ERROR: stage folder not found: $Stage" -ForegroundColor Red
    Write-Host "Create it first (portable node.exe + prebuilt node_modules + Chromium, see HANDOFF-WINDOWS.md phase 2)."
    exit 1
}

# Guard: a previous broken run copied the stage into itself. Refuse to run
# until the nested copy is removed, so robocopy can never recurse again.
$NestedStage = Join-Path $Stage 'windows\installer\stage'
if (Test-Path $NestedStage) {
    Write-Host "ERROR: found a nested copy of the stage at $NestedStage" -ForegroundColor Red
    Write-Host "Delete it first (it is NOT part of the installer):"
    Write-Host "  Remove-Item -Recurse -Force '$NestedStage'"
    exit 1
}

Write-Host "Refreshing app files from: $RepoRoot"
Write-Host "                     into: $Stage"

# Everything except personal data and caches - matches HANDOFF phase 2.
# Name-based exclusions also protect any nesting; the stage dir is excluded
# by its full path so robocopy can never copy the stage into itself.
$ExcludeDirs = @(
    'node_modules', '.npm-cache', '.puppeteer-cache',
    'dist', 'logs', 'screenshots', 'uploads', 'presentation', 'future'
)
$ExcludeDirsFull = @(
    (Join-Path $RepoRoot '.git'),
    $Stage
)
$ExcludeFiles = @(
    'cookies.json', 'sources.json', '.env.config', 'posts.db',
    'state.json', 'ig-explorer.service', '.gitignore', '.dockerignore',
    'ig-feed-watcher.code-workspace'
)

$robocopyArgs = @($RepoRoot, $Stage, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
foreach ($d in $ExcludeDirs) { $robocopyArgs += '/XD'; $robocopyArgs += $d }
foreach ($d in $ExcludeDirsFull) { $robocopyArgs += '/XD'; $robocopyArgs += $d }
foreach ($f in $ExcludeFiles) { $robocopyArgs += '/XF'; $robocopyArgs += $f }

robocopy @robocopyArgs | Out-Host
$code = $LASTEXITCODE
if ($code -ge 8) {
    Write-Host "ERROR: robocopy failed (exit code $code)" -ForegroundColor Red
    exit 1
}

# Sanitize groups.json: drop the personal "Photos" group (case-insensitive)
# so recipients never get it seeded. Repo groups.json is not touched.
if (Test-Path $GroupsJson) {
    $data = $null
    try {
        $data = Get-Content $GroupsJson -Raw | ConvertFrom-Json
    } catch {
        Write-Host "WARNING: could not parse stage\groups.json - leaving it untouched" -ForegroundColor Yellow
    }
    if ($null -ne $data -and $null -ne $data.groups) {
        $before = @($data.groups).Count
        $kept = @($data.groups | Where-Object { $_.name -and ($_.name -ne 'Photos') })
        $after = @($kept).Count
        if ($after -lt $before) {
            $data.groups = $kept
            # UTF-8 without BOM - Node's JSON.parse rejects a leading BOM.
            $json = $data | ConvertTo-Json -Depth 8
            [System.IO.File]::WriteAllText($GroupsJson, $json, (New-Object System.Text.UTF8Encoding($false)))
            Write-Host "Removed $($before - $after) 'Photos' group(s) from stage\groups.json ($before -> $after groups)."
        } else {
            Write-Host "stage\groups.json already clean - no 'Photos' group present."
        }
    }
} else {
    Write-Host "NOTE: stage\groups.json not found - nothing to sanitize." -ForegroundColor Yellow
}

Write-Host "Done. Stage is ready - compile with windows\installer\ig-feed-watcher.iss (ISCC.exe)."
