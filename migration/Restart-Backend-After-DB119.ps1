$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$backendFile = Join-Path $projectRoot 'app\backend\server.js'
$nodeFile = Join-Path $projectRoot 'runtime\node\node.exe'
$pidFile = Join-Path $projectRoot 'run\backend.pid'
Get-Content -LiteralPath (Join-Path $projectRoot 'settings.env') | ForEach-Object {
    $line = $_.TrimStart([char]0xFEFF)
    if ($line -match '^\s*([^#=]+)=(.*)$' -and $matches[1].Trim() -ne 'PATH') {
        [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2], 'Process')
    }
}
$env:DATA_DIR = Join-Path $projectRoot 'data\app'
$env:FRONTEND_DIST_DIR = Join-Path $projectRoot 'app\frontend\dist'
$env:TELEGRAF_CONFIG_PATH = Join-Path $projectRoot 'app\telegraf\telegraf.d\plc.conf'
$env:BOP_CONFIG_PATH = Join-Path $projectRoot 'data\app\bop_config.json'
if (-not $env:PGHOST) { $env:PGHOST = '127.0.0.1' }
$listener = Get-NetTCPConnection -State Listen -LocalPort 8080 -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener -or (Test-Path -LiteralPath $pidFile)) {
    # An offline archive can contain a PID from its source PC. Prefer the actual
    # local HTTP listener and verify its executable and project before stopping.
    $backendProcessId = if ($listener) { [int]$listener.OwningProcess } else { [int](Get-Content -LiteralPath $pidFile -Raw).Trim() }
    $running = Get-CimInstance Win32_Process -Filter "ProcessId=$backendProcessId" -ErrorAction SilentlyContinue
    if ($running) {
        if ($running.ExecutablePath -ne $nodeFile -or -not $running.CommandLine.Contains($backendFile)) { throw 'PID does not belong to this project backend.' }
        Stop-Process -Id $backendProcessId
        Wait-Process -Id $backendProcessId -Timeout 10 -ErrorAction SilentlyContinue
    }
}
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$proc = Start-Process -FilePath $nodeFile -ArgumentList ('"' + $backendFile + '"') -WorkingDirectory (Join-Path $projectRoot 'app\backend') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $projectRoot "logs\backend-db119-$stamp.log") -RedirectStandardError (Join-Path $projectRoot "logs\backend-db119-$stamp.err.log")
Set-Content -LiteralPath $pidFile -Value $proc.Id -Encoding ASCII
for ($attempt=0; $attempt -lt 20; $attempt++) {
    $proc.Refresh()
    if ($proc.HasExited) { throw 'The new backend exited before becoming ready. Inspect its log.' }
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/healthz' -TimeoutSec 2
        Write-Output "Backend restarted (PID $($proc.Id)); health=$($health.status)"
        exit 0
    } catch { Start-Sleep -Milliseconds 500 }
}
throw 'Backend did not become ready. Inspect the backend-db119 logs.'
