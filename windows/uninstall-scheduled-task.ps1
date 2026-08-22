# ═══════════════════════════════════════════════════════════════════════════
#  IG Feed Watcher — remove the scheduled task (stops the automatic watcher)
#  Run via uninstall-scheduled-task.bat
# ═══════════════════════════════════════════════════════════════════════════
$ErrorActionPreference = "Stop"
$TaskName = "IG Feed Watcher"

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "❌ Scheduled task '$TaskName' removed. The watcher will no longer run automatically." -ForegroundColor Yellow
} else {
    Write-Host "No scheduled task named '$TaskName' was found — nothing to remove."
}
