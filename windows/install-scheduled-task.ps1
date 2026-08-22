# ═══════════════════════════════════════════════════════════════════════════
#  IG Feed Watcher — register the Windows scheduled task
#  Makes Windows run the watcher every 5 minutes automatically,
#  even after a reboot or logout. No admin rights needed.
#  Run via install-scheduled-task.bat (or: powershell -ExecutionPolicy Bypass
#  -File install-scheduled-task.ps1)
# ═══════════════════════════════════════════════════════════════════════════
$ErrorActionPreference = "Stop"

# Root of the project = parent of the windows\ folder this script lives in
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

# Prefer a bundled portable Node (installer model: node.exe sits in $Root);
# otherwise fall back to Node on PATH.
$BundledNode = Join-Path $Root 'node.exe'
if (Test-Path $BundledNode) {
    $Node = $BundledNode
} elseif (Get-Command node -ErrorAction SilentlyContinue) {
    $Node = (Get-Command node).Source
} else {
    Write-Host "Node.js was not found. Run install.bat first." -ForegroundColor Red
    exit 1
}

$TaskName = "IG Feed Watcher"

# Action: run `node watcher.js` once from the project folder
$Action = New-ScheduledTaskAction -Execute $Node -Argument "watcher.js" -WorkingDirectory $Root

# Trigger: every 5 minutes, forever
$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration ([TimeSpan]::MaxValue)

# Settings: don't miss runs after the PC was off; restart on failure
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Hours 1)

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger `
    -Settings $Settings -Description "IG Feed Watcher - checks Instagram for new posts every 5 minutes" `
    -Force | Out-Null

Write-Host ""
Write-Host "✅ Scheduled task registered: '$TaskName'" -ForegroundColor Green
Write-Host "   Windows will now run the watcher every 5 minutes, automatically."
Write-Host "   (You can stop it anytime with uninstall-scheduled-task.bat)"
Write-Host ""
