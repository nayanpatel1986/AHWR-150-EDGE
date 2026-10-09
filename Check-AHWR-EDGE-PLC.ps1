$ErrorActionPreference = 'Continue'

$Root = $PSScriptRoot
$SettingsFile = Join-Path $Root 'settings.env'
$PlcConfig = Join-Path $Root 'data\app\plc_config.json'
$InfluxCli = Join-Path $Root 'runtime\influx\influx.exe'

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
foreach ($pidFileName in @('influxdb.pid', 'telegraf.pid', 'backend.pid', 'bop-collector.pid')) {
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
Write-Host 'InfluxDB latest AHWR points:' -ForegroundColor Cyan
if (Test-Path -LiteralPath $InfluxCli) {
    $query = @'
from(bucket: "romii_bucket")
  |> range(start: -10m)
  |> filter(fn: (r) => r._measurement == "AHWR")
  |> limit(n: 10)
'@
    try {
        & $InfluxCli query --host 'http://127.0.0.1:8086' --org $env:INFLUX_ORG --token $env:INFLUX_TOKEN $query
    } catch {
        Write-Host "Influx query failed: $($_.Exception.Message)" -ForegroundColor Red
    }
} else {
    Write-Host "Missing Influx CLI: $InfluxCli" -ForegroundColor Red
}

Write-Host ''
Write-Host 'If PLC TCP is OK but no AHWR points appear, read the Telegraf error lines above first.' -ForegroundColor Yellow
