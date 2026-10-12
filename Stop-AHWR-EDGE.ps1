param(
    # Also stop the backend (dashboard) and PostgreSQL.
    [switch]$All
)
$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot
$RunDir = Join-Path $Root 'run'

# Windows services (Install-AHWR-EDGE-Services.ps1): stop collection; with -All
# also the backend and the bundled PostgreSQL. They start again at the next boot
# or with Start-AHWR-EDGE.bat. Stopping a service needs an elevated PowerShell.
if (Get-Service 'AHWR-Backend' -ErrorAction SilentlyContinue) {
    $names = @('AHWR-BOP-Collector', 'AHWR-Telegraf')
    if ($All) { $names += @('AHWR-Backend', 'AHWR-PostgreSQL') }
    foreach ($name in $names) {
        $svc = Get-Service $name -ErrorAction SilentlyContinue
        if (-not $svc -or $svc.Status -eq 'Stopped') { continue }
        try { Stop-Service $name -Force -ErrorAction Stop; Write-Host "Stopped service $name." }
        catch { Write-Host "Could not stop $name ($($_.Exception.Message)). Run this as Administrator." -ForegroundColor Yellow }
    }
    if ($All) { Write-Host 'AHWR-EDGE services stopped.' }
    else { Write-Host 'AHWR-EDGE collection stopped. The dashboard UI remains available; refresh it to see NO DATA.' }
    return
}

# Portable processes. Without -All the backend UI server and PostgreSQL keep
# running: an open browser refreshes into the dashboard shell with -- / NO DATA
# values, and logbook/work-order records can still be saved.
$processes = @('bop-collector', 'telegraf')
if ($All) { $processes += 'backend' }
foreach ($name in $processes) {
    $pidFile = Join-Path $RunDir "$name.pid"
    if (-not (Test-Path -LiteralPath $pidFile)) { continue }
    $serviceId = 0
    if ([int]::TryParse((Get-Content -LiteralPath $pidFile -Raw), [ref]$serviceId)) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$serviceId" -ErrorAction SilentlyContinue
        if ($proc -and $proc.ExecutablePath -and $proc.ExecutablePath.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)) {
            if ($name -eq 'backend') {
                # Graceful: the backend saves pending records, then exits.
                Set-Content -LiteralPath (Join-Path $RunDir 'backend.stop') -Value 'stop' -Encoding ASCII
                Wait-Process -Id $serviceId -Timeout 20 -ErrorAction SilentlyContinue
                Remove-Item -LiteralPath (Join-Path $RunDir 'backend.stop') -Force -ErrorAction SilentlyContinue
            }
            Stop-Process -Id $serviceId -Force -ErrorAction SilentlyContinue
            Write-Host "Stopped $name (PID $serviceId)."
        }
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

# With -All the bundled PostgreSQL (PG_MODE=bundled) is stopped cleanly, after
# the backend; an installed PostgreSQL service (PG_MODE=service) is left to Windows.
$pgCtl = Join-Path $Root 'runtime\pgsql\bin\pg_ctl.exe'
$pgData = Join-Path $Root 'data\pgdata'
if ($All -and (Test-Path -LiteralPath $pgCtl) -and (Test-Path -LiteralPath (Join-Path $pgData 'postmaster.pid'))) {
    & $pgCtl stop -D $pgData -m fast -w | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Host 'Stopped PostgreSQL + TimescaleDB.' } else { Write-Host 'PostgreSQL did not stop cleanly; see logs\postgresql.log.' -ForegroundColor Yellow }
}
if ($All) { Write-Host 'AHWR-EDGE stopped.' }
else { Write-Host 'AHWR-EDGE live services stopped. The dashboard UI remains available; refresh it to see NO DATA.' }
