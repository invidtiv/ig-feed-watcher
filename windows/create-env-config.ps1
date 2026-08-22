# ═══════════════════════════════════════════════════════════════════════════
#  IG Feed Watcher - create .env.config from the template (first run)
#  Copies .env.example -> .env.config if .env.config does not exist yet.
#  Never ships real secrets - recipients edit placeholders via the web UI /
#  COOKIES-GUIDE.md. Called by the installer's [Run] step.
# ═══════════════════════════════════════════════════════════════════════════
$ErrorActionPreference = "Stop"

# Root of the project = parent of the windows\ folder this script lives in
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

$Example = Join-Path $Root '.env.example'
$Config = Join-Path $Root '.env.config'

if (Test-Path $Config) {
    Write-Host "OK .env.config already exists - leaving it untouched."
} elseif (Test-Path $Example) {
    Copy-Item $Example $Config
    Write-Host "OK Created .env.config from the template."
} else {
    Write-Host "WARNING: .env.example not found - .env.config was not created." -ForegroundColor Yellow
}
