param([int]$KeepDays = 14)
$ErrorActionPreference = 'Stop'
# Backs up the operating records: users, work orders, logbook, calibrations,
# alarm settings and events, the well registry and other app documents
# (schema app), plus wells, well runs, rigs, the tag dictionary and the import
# catalogue. The full-rate telemetry is not included (the CMF holds a copy).
# Install-AHWR-EDGE-Services.ps1 schedules it daily; backups\ keeps $KeepDays days.
#
# Restore into a running PostgreSQL with the backend stopped (it holds the records
# in memory), as postgres, then start the backend again:
#   Stop-Service AHWR-BOP-Collector, AHWR-Backend        (or Stop-AHWR-EDGE.ps1 -All, then start PostgreSQL only)
#   psql -h 127.0.0.1 -U postgres -d ahwr_edge -c "TRUNCATE app.documents, wells, well_runs, rigs, tags, telemetry_imports"
#   pg_restore -h 127.0.0.1 -U postgres -d ahwr_edge --data-only --disable-triggers --exit-on-error <file>
$Root = $PSScriptRoot
$SettingsFile = Join-Path $Root 'settings.env'
$BackupDir = Join-Path $Root 'backups'
Get-Content -LiteralPath $SettingsFile | ForEach-Object {
    $line = $_.TrimStart([char]0xFEFF)
    if ($line -match '^\s*([^#=]+)=(.*)$' -and $matches[1].Trim() -ne 'PATH') { [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2], 'Process') }
}
$pgDump = Join-Path $Root 'runtime\pgsql\bin\pg_dump.exe'
if (-not (Test-Path -LiteralPath $pgDump)) {
    $installed = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\pg_dump.exe' -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
    if (-not $installed) { throw 'pg_dump.exe not found.' }
    $pgDump = $installed.FullName
}
$null = New-Item -ItemType Directory -Force -Path $BackupDir
$file = Join-Path $BackupDir ("records-{0}.dump" -f (Get-Date -Format 'yyyyMMdd-HHmm'))
$pgHost = if ($env:PGHOST) { $env:PGHOST } else { '127.0.0.1' }
$pgPort = if ($env:PGPORT) { $env:PGPORT } else { '5432' }
$pgDb = if ($env:PGDATABASE) { $env:PGDATABASE } else { 'ahwr_edge' }
& $pgDump -h $pgHost -p $pgPort -U ahwr_app -d $pgDb -Fc -f $file `
    -t 'app.*' -t public.wells -t public.well_runs -t public.rigs -t public.tags -t public.telemetry_imports
if ($LASTEXITCODE -ne 0) { throw 'pg_dump failed.' }
Get-ChildItem -LiteralPath $BackupDir -Filter 'records-*.dump' | Where-Object LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) | Remove-Item
Write-Host "Records backed up to $file"
