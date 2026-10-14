param(
    # Days of full-rate history to copy; older history becomes 1-minute mean/min/max.
    [double]$RawDays = 90,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
# One-time copy of the InfluxDB-edition history into TimescaleDB.
# Run AFTER Start-AHWR-EDGE.ps1 has started the TimescaleDB edition. Live
# collection can keep running: only time before the first TimescaleDB sample is
# copied. Safe to stop and re-run; it resumes. Needs the old InfluxDB runtime
# (runtime\influx\influxd.exe) and data (data\influx).
$Root = $PSScriptRoot
$SettingsFile = Join-Path $Root 'settings.env'
$Node = Join-Path $Root 'runtime\node\node.exe'
$Influxd = Join-Path $Root 'runtime\influx\influxd.exe'
$InfluxData = Join-Path $Root 'data\influx'
$Script = Join-Path $Root 'app\backend\scripts\migrate-influx-to-timescale.js'
foreach ($path in @($SettingsFile, $Node, $Influxd, $InfluxData, $Script)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Missing $path" }
}
Get-Content -LiteralPath $SettingsFile | ForEach-Object {
    $line = $_.TrimStart([char]0xFEFF)
    if ($line -match '^\s*([^#=]+)=(.*)$' -and $matches[1].Trim() -ne 'PATH') {
        [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2], 'Process')
    }
}
foreach ($key in @('INFLUX_TOKEN', 'INFLUX_ORG', 'INFLUX_BUCKET', 'DEVICE_ID')) {
    if (-not [Environment]::GetEnvironmentVariable($key, 'Process')) { throw "settings.env has no $key (needed to read the old historian)." }
}
if (-not $env:PG_SUPERUSER_PASSWORD) {
    $secure = Read-Host 'PostgreSQL postgres password' -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $env:PG_SUPERUSER_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Test-Port([int]$Port) {
    try { $c = New-Object Net.Sockets.TcpClient; $ok = $c.ConnectAsync('127.0.0.1', $Port).Wait(500) -and $c.Connected; $c.Dispose(); $ok } catch { $false }
}

$influxProc = $null
if (-not (Test-Port 8086)) {
    Write-Host 'Starting the old InfluxDB (read-only use) on 127.0.0.1:8086...' -ForegroundColor Cyan
    $influxProc = Start-Process -FilePath $Influxd -WindowStyle Hidden -PassThru -ArgumentList @(
        'run', '--http-bind-address', '127.0.0.1:8086',
        '--bolt-path', "`"$InfluxData\influxd.bolt`"", '--engine-path', "`"$InfluxData\engine`"", '--sqlite-path', "`"$InfluxData\influxd.sqlite`"")
    for ($i = 0; $i -lt 60 -and -not (Test-Port 8086); $i++) { Start-Sleep -Seconds 1 }
    if (-not (Test-Port 8086)) { throw 'InfluxDB did not start.' }
}
try {
    $env:INFLUX_URL = 'http://127.0.0.1:8086'
    $env:DATA_DIR = Join-Path $Root 'data\app'
    $env:PGUSER = 'postgres'
    $env:PGPASSWORD = $env:PG_SUPERUSER_PASSWORD
    $nodeArgs = @("`"$Script`"", '--raw-days', "$RawDays")
    if ($DryRun) { $nodeArgs += '--dry-run' }
    & $Node @nodeArgs
    if ($LASTEXITCODE -ne 0) { throw 'Migration failed; fix the error above and run this script again (it resumes).' }
} finally {
    if ($influxProc) { Stop-Process -Id $influxProc.Id -Force -ErrorAction SilentlyContinue; Write-Host 'Stopped the old InfluxDB.' }
}
Write-Host 'History migrated. Restart the backend (Stop/Start) so it back-fills well runs.' -ForegroundColor Green
