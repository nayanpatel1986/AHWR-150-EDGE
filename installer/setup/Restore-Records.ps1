# Restores a records backup (users, settings, wells and runs, work orders, alarms
# configuration, ...) into this edge, e.g. on a replacement PC installed with the
# same DeviceId. The telemetry history is not part of the records backup.
# Usage: Restore-Records.bat <backup file>   Windows PowerShell 5.1.
param([Parameter(Position = 0)][string]$File = '', [switch]$PauseAtEnd)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
Import-Module (Join-Path $PSScriptRoot 'AhwrSetup.psm1') -Force -DisableNameChecking
if (-not (Test-IsAdministrator)) {
    $pass = @()
    if ($File) { $pass = @(('"{0}"' -f $File)) }
    Restart-Elevated $PSCommandPath $pass
}

$Root = Get-AhwrInstallRoot
$code = 1
try {
    $settingsPath = Join-Path $Root 'settings.env'
    if (-not (Test-Path -LiteralPath $settingsPath)) { throw "AHWR-EDGE is not installed in $Root." }
    $backups = Join-Path $Root 'backups'
    if (-not $File) {
        Write-Host 'Usage: Restore-Records.bat <backup file>' -ForegroundColor Yellow
        $recent = @(Get-ChildItem -LiteralPath $backups -Filter 'records-*.dump' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 5)
        if ($recent.Count) { Write-Host 'Newest backups on this PC:'; $recent | ForEach-Object { Write-Host "  $($_.FullName)" } }
        throw 'No backup file given.'
    }
    if (-not [IO.Path]::IsPathRooted($File) -and (Test-Path -LiteralPath (Join-Path $backups $File))) { $File = Join-Path $backups $File }
    if (-not (Test-Path -LiteralPath $File)) { throw "Backup file not found: $File" }
    $File = (Resolve-Path -LiteralPath $File).Path
    $settings = Read-EnvFile $settingsPath
    Set-SetupLog (Join-Parts $Root 'logs' 'restore-records.log')

    Write-Host "This replaces ALL operating records of rig $($settings['DEVICE_ID']) with:" -ForegroundColor Yellow
    Write-Host "  $File"
    Write-Host 'The PLC history (telemetry) is not touched. Run Backup-Now.bat first if the current records matter.'
    if ((Read-Host 'Type RESTORE to continue') -cne 'RESTORE') { throw 'Cancelled; nothing was changed.' }

    Invoke-Stage 1 2 'Restore' {
        Stop-AhwrServices @('AHWR-BOP-Collector', 'AHWR-Backend')   # the backend holds the records in memory
        Add-Check 'Services' 'OK' 'AHWR-Backend and AHWR-BOP-Collector stopped'
        $null = Invoke-EdgeSql $Root $settings 'TRUNCATE app.documents, wellbores, wells, well_runs, rigs, tags, telemetry_imports' -AsSuperuser
        $env:PGPASSWORD = $settings['PG_SUPERUSER_PASSWORD']
        try {
            $r = Invoke-Native (Join-Parts $Root 'runtime' 'pgsql' 'bin' 'pg_restore.exe') @('-h', '127.0.0.1', '-p', $settings['PGPORT'], '-U', 'postgres',
                '-d', $settings['PGDATABASE'], '--data-only', '--disable-triggers', '--exit-on-error', $File)
        } finally { $env:PGPASSWORD = $null }
        if ($r.ExitCode -ne 0) { throw "pg_restore failed: $(($r.Output | Select-Object -Last 2) -join ' '). Records are now empty: restore another backup." }
        Add-Check 'Records' 'OK' "restored from $(Split-Path -Leaf $File)"
        Start-AhwrServices @('AHWR-Backend', 'AHWR-BOP-Collector')
        if (-not (Wait-HttpOk 'http://127.0.0.1:8080/healthz' 90)) { throw 'the web UI does not answer; see logs\AHWR-Backend.log' }
        Add-Check 'Services' 'OK' 'started; web UI answers'
    }
    Invoke-Stage 2 2 'Self-test' { Invoke-SelfTest $Root }
    Write-Host ''
    Write-Host 'RECORDS RESTORED' -ForegroundColor Green
    Write-Host 'Replacement PC: before it uploads, the CMF administrator must clear this rig''s last sequence number, or the CMF discards its data.' -ForegroundColor Yellow
    $code = 0
} catch {
    Write-Host ''
    Write-Host $_.Exception.Message -ForegroundColor Red
} finally {
    if ($PauseAtEnd) { $null = Read-Host 'Press Enter to close this window' }
}
exit $code
