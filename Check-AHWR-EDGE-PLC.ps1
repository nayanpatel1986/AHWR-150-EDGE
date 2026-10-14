$ErrorActionPreference = 'Continue'

$Root = $PSScriptRoot
$SettingsFile = Join-Path $Root 'settings.env'
$PlcConfig = Join-Path $Root 'data\app\plc_config.json'
$Psql = Join-Path $Root 'runtime\pgsql\bin\psql.exe'
if (-not (Test-Path -LiteralPath $Psql)) {
    $installed = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\psql.exe' -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
    if ($installed) { $Psql = $installed.FullName }
}

Write-Host 'AHWR-EDGE PLC/data diagnostic' -ForegroundColor Cyan
Write-Host "Root: $Root"
Write-Host ''

if (Test-Path -LiteralPath $SettingsFile) {
    Get-Content -LiteralPath $SettingsFile | ForEach-Object {
        $line = $_.TrimStart([char]0xFEFF)
        if ($line -match '^\s*([^#=]+)=(.*)$') {
            [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2], 'Process')
        }
    }
} else {
    Write-Host "Missing settings file: $SettingsFile" -ForegroundColor Red
}

$plc = $null
if (Test-Path -LiteralPath $PlcConfig) {
    try {
        $config = Get-Content -LiteralPath $PlcConfig -Raw | ConvertFrom-Json
        $plc = $config.slaves | Select-Object -First 1
        Write-Host "Configured PLC: $($plc.name) $($plc.ip):$($plc.port) rack=$($plc.rack) slot=$($plc.slot)"
    } catch {
        Write-Host "Could not read PLC config: $($_.Exception.Message)" -ForegroundColor Red
    }
} else {
    Write-Host "Missing PLC config: $PlcConfig" -ForegroundColor Red
}

Write-Host ''
Write-Host 'Process check:' -ForegroundColor Cyan
foreach ($pidFileName in @('telegraf.pid', 'backend.pid', 'bop-collector.pid')) {
    $pidFile = Join-Path $Root "run\$pidFileName"
    if (Test-Path -LiteralPath $pidFile) {
        $pidValue = (Get-Content -LiteralPath $pidFile -Raw).Trim()
        $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host "OK $pidFileName -> $($proc.ProcessName) PID $pidValue" -ForegroundColor Green
        } else {
            Write-Host "NOT RUNNING $pidFileName had PID $pidValue" -ForegroundColor Yellow
        }
    } else {
        Write-Host "MISSING $pidFileName" -ForegroundColor Yellow
    }
}

Write-Host ''
Write-Host 'Backend check:' -ForegroundColor Cyan
try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/healthz' -TimeoutSec 5
    Write-Host "OK backend health: $($health.status)" -ForegroundColor Green
} catch {
    Write-Host "FAILED backend health: $($_.Exception.Message)" -ForegroundColor Red
}

if ($plc) {
    Write-Host ''
    Write-Host 'PLC network check:' -ForegroundColor Cyan
    try {
        $test = Test-NetConnection $plc.ip -Port $plc.port -WarningAction SilentlyContinue
        if ($test.TcpTestSucceeded) {
            Write-Host "OK PLC TCP $($plc.ip):$($plc.port)" -ForegroundColor Green
        } else {
            Write-Host "FAILED PLC TCP $($plc.ip):$($plc.port)" -ForegroundColor Red
        }
    } catch {
        Write-Host "FAILED PLC TCP test: $($_.Exception.Message)" -ForegroundColor Red
    }
}

Write-Host ''
Write-Host 'Recent Telegraf errors:' -ForegroundColor Cyan
$telegrafErr = Join-Path $Root 'logs\telegraf.err.log'
$telegrafLog = Join-Path $Root 'logs\telegraf.log'
foreach ($log in @($telegrafErr, $telegrafLog)) {
    Write-Host "--- $log"
    if (Test-Path -LiteralPath $log) {
        Get-Content -LiteralPath $log -Tail 80
    } else {
        Write-Host 'Log file not found.'
    }
}

Write-Host ''
Write-Host 'TimescaleDB latest telemetry (this rig):' -ForegroundColor Cyan
if (Test-Path -LiteralPath $Psql) {
    $pgHost = if ($env:PGHOST) { $env:PGHOST } else { '127.0.0.1' }
    $pgPort = if ($env:PGPORT) { $env:PGPORT } else { '5432' }
    $pgDb = if ($env:PGDATABASE) { $env:PGDATABASE } else { 'ahwr_edge' }
    $pgUser = if ($env:PGUSER) { $env:PGUSER } else { 'ahwr_app' }
    $rig = $env:DEVICE_ID -replace "'", ''
    $query = @"
SELECT count(DISTINCT metric) AS metrics_last_minute, max(ts) AS newest_sample, now() AS db_time
FROM telemetry WHERE rig_id = '$rig' AND ts > now() - interval '1 minute';
SELECT metric, round(value::numeric, 3) AS value, ts FROM telemetry
WHERE rig_id = '$rig' AND ts > now() - interval '1 minute' ORDER BY ts DESC LIMIT 10;
"@
    try {
        & $Psql -X -h $pgHost -p $pgPort -U $pgUser -d $pgDb -c $query
    } catch {
        Write-Host "TimescaleDB query failed: $($_.Exception.Message)" -ForegroundColor Red
    }
} else {
    Write-Host 'psql not found (runtime\pgsql\bin or C:\Program Files\PostgreSQL\*\bin).' -ForegroundColor Red
}

Write-Host ''
Write-Host 'If PLC TCP is OK but no telemetry appears, read the Telegraf error lines above first.' -ForegroundColor Yellow
