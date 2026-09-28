# Start the installed web app and open it only after it answers HTTP requests.
# Dot-sourcing exposes the functions for isolated launcher tests.
function Test-FeedWatcherReady {
    param([string]$Url)
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop
        return $response.StatusCode -eq 200 -and $response.Content -match '<title>IG Feed Watcher.+Explorer</title>'
    } catch {
        return $false
    }
}

function Open-FeedWatcherUrl {
    param([string]$Url)
    # A URL must use the Windows shell association, not CreateProcess.
    Start-Process -FilePath $Url -ErrorAction Stop
}

function Open-FeedWatcher {
    param(
        [string]$AppRoot = (Split-Path -Parent $PSScriptRoot),
        [int]$StartupTimeoutSeconds = 30
    )
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $port = 4180
    if ($env:PORT) {
        if (-not [int]::TryParse($env:PORT, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
            throw 'PORT must be a whole number between 1 and 65535.'
        }
    }
    $url = "http://127.0.0.1:$port/"
    $server = $null
    if (-not (Test-FeedWatcherReady $url)) {
        $node = Join-Path $AppRoot 'node.exe'
        $serverFile = Join-Path $AppRoot 'server.js'
        if (-not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath $serverFile)) {
            throw 'The bundled app files are missing. Please reinstall IG Feed Watcher.'
        }
        $logs = Join-Path $AppRoot 'logs'
        New-Item -ItemType Directory -Path $logs -Force | Out-Null
        $server = Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $AppRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs 'server.log') -RedirectStandardError (Join-Path $logs 'server-error.log')
        $deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
        while (-not (Test-FeedWatcherReady $url)) {
            $server.Refresh()
            if ($server.HasExited) {
                throw "The web app could not start. See $logs\server-error.log. Another app may be using port $port."
            }
            if ([DateTime]::UtcNow -ge $deadline) {
                throw "The web app is taking too long to start. See $logs\server-error.log and try the desktop shortcut again."
            }
            Start-Sleep -Milliseconds 200
        }
    }
    Open-FeedWatcherUrl $url
    [PSCustomObject]@{ Url = $url; Started = ($null -ne $server); ProcessId = $(if ($server) { $server.Id } else { $null }) }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        Open-FeedWatcher | Out-Null
    } catch {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'IG Feed Watcher', 'OK', 'Error') | Out-Null
        exit 1
    }
}
