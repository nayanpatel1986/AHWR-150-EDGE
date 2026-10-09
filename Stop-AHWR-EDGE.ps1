$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot
$RunDir = Join-Path $Root 'run'
# Keep the backend UI server running so an open browser can refresh into the
# dashboard shell with -- / NO DATA values while live services are stopped.
foreach ($name in @('bop-collector', 'telegraf', 'influxdb')) {
    $pidFile = Join-Path $RunDir "$name.pid"
    if (-not (Test-Path -LiteralPath $pidFile)) { continue }
    $serviceId = 0
    if ([int]::TryParse((Get-Content -LiteralPath $pidFile -Raw), [ref]$serviceId)) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$serviceId" -ErrorAction SilentlyContinue
        if ($proc -and $proc.ExecutablePath -and $proc.ExecutablePath.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)) {
            Stop-Process -Id $serviceId -Force
            Write-Host "Stopped $name (PID $serviceId)."
        }
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}
Write-Host 'AHWR-EDGE live services stopped. The dashboard UI remains available; refresh it to see NO DATA.'
