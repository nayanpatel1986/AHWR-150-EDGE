$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot
$RunDir = Join-Path $Root 'run'
# Keep the backend UI server running so an open browser can refresh into the
# dashboard shell with -- / NO DATA values while live services are stopped.
foreach ($name in @('bop-collector', 'telegraf')) {
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

# Bundled PostgreSQL (PG_MODE=bundled) is stopped cleanly; an installed
# PostgreSQL service (PG_MODE=service) is left to Windows.
$pgCtl = Join-Path $Root 'runtime\pgsql\bin\pg_ctl.exe'
$pgData = Join-Path $Root 'data\pgdata'
if ((Test-Path -LiteralPath $pgCtl) -and (Test-Path -LiteralPath (Join-Path $pgData 'postmaster.pid'))) {
    & $pgCtl stop -D $pgData -m fast -w | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Host 'Stopped PostgreSQL + TimescaleDB.' } else { Write-Host 'PostgreSQL did not stop cleanly; see logs\postgresql.log.' -ForegroundColor Yellow }
}
Write-Host 'AHWR-EDGE live services stopped. The dashboard UI remains available; refresh it to see NO DATA.'
