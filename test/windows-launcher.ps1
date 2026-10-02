param([string]$AppRoot = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
. (Join-Path $AppRoot 'windows\open-app.ps1')
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('ig-launcher-' + [Guid]::NewGuid().ToString('N'))
$originalPort = $env:PORT
$originalRetention = $env:AUTO_RETENTION
$startedId = $null
function Assert-True($condition, $message) { if (-not $condition) { throw $message } }
function Get-TestPort {
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $result = $listener.LocalEndpoint.Port
    $listener.Stop()
    return $result
}
# Capture the URL at the shell boundary and prove readiness at that moment.
$script:openCalls = 0
function Open-FeedWatcherUrl {
    param([string]$Url)
    Assert-True (Test-FeedWatcherReady $Url) 'Browser opened before HTTP readiness'
    $script:openCalls++
}
try {
    New-Item -ItemType Directory -Path $fixture | Out-Null
    foreach ($file in @('server.js','sources.js','runtime-policy.js','retention.js','contract-policy.js','skill-policy.js','ai.js','group-match.js','package.json')) {
        Copy-Item -LiteralPath (Join-Path $AppRoot $file) -Destination $fixture
    }
    $node = Join-Path $AppRoot 'node.exe'
    if (-not (Test-Path $node)) { $node = Join-Path $AppRoot 'windows\installer\stage\node.exe' }
    Copy-Item -LiteralPath $node -Destination (Join-Path $fixture 'node.exe')
    New-Item -ItemType Junction -Path (Join-Path $fixture 'node_modules') -Target (Join-Path $AppRoot 'node_modules') | Out-Null
    $env:PORT = [string](Get-TestPort)
    $env:AUTO_RETENTION = '0'
    $result = Open-FeedWatcher -AppRoot $fixture -StartupTimeoutSeconds 10
    $startedId = $result.ProcessId
    Assert-True $result.Started 'Fresh launch did not start bundled Node'
    Assert-True ($script:openCalls -eq 1) 'Fresh launch did not open URL exactly once'
    $again = Open-FeedWatcher -AppRoot $fixture
    Assert-True (-not $again.Started) 'Repeated launch started a duplicate server'
    Assert-True ($script:openCalls -eq 2) 'Repeated launch did not reopen URL'
    $sources = Invoke-WebRequest ($result.Url + 'settings/sources') -UseBasicParsing
    Assert-True ($sources.Content -notmatch 'id="retention-section"') 'Retention gate regressed'
    Stop-Process -Id $startedId
    Wait-Process -Id $startedId -ErrorAction SilentlyContinue
    $startedId = $null
    $env:PORT = [string](Get-TestPort)
    $failed = $false
    try { Open-FeedWatcher -AppRoot (Join-Path $fixture 'missing') } catch { $failed = $_.Exception.Message -match 'bundled app files are missing' }
    Assert-True $failed 'Missing runtime must produce a useful error'
    $env:PORT = 'invalid'
    $failed = $false
    try { Open-FeedWatcher -AppRoot $fixture } catch { $failed = $_.Exception.Message -match 'PORT must' }
    Assert-True $failed 'Invalid port must fail before launching'
    $env:PORT = [string](Get-TestPort)
    [IO.File]::WriteAllText((Join-Path $fixture 'server.js'), 'throw new Error("Intentional launcher test failure");')
    $failed = $false
    try { Open-FeedWatcher -AppRoot $fixture -StartupTimeoutSeconds 5 } catch { $failed = $_.Exception.Message -match 'could not start' }
    Assert-True $failed 'Crashed server must produce a useful error'
    Assert-True ($script:openCalls -eq 2) 'Failure must not open browser'
    Write-Output 'PASS: fresh startup/readiness, repeat launch, retention gate, missing runtime, invalid port, crashed server'
} finally {
    if ($startedId) { Stop-Process -Id $startedId -ErrorAction SilentlyContinue }
    $env:PORT = $originalPort
    $env:AUTO_RETENTION = $originalRetention
    # The unique test directory is the only recursive cleanup target.
    if ($fixture.StartsWith([IO.Path]::GetTempPath()) -and (Split-Path $fixture -Leaf) -like 'ig-launcher-*') {
        # Remove only the junction itself before deleting the disposable fixture.
        $junction = Join-Path $fixture 'node_modules'
        if (Test-Path $junction) { [IO.Directory]::Delete($junction) }
        Remove-Item -LiteralPath $fixture -Recurse -Force
    }
}
