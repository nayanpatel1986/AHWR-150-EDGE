# Backs up the operating records now (the same backup the daily task makes).
# Windows PowerShell 5.1.
param([switch]$PauseAtEnd)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
Import-Module (Join-Path $PSScriptRoot 'AhwrSetup.psm1') -Force -DisableNameChecking
if (-not (Test-IsAdministrator)) { Restart-Elevated $PSCommandPath }

$Root = Get-AhwrInstallRoot
$code = 1
try {
    $script = Join-Path $Root 'Backup-AHWR-EDGE-Records.ps1'
    if (-not (Test-Path -LiteralPath $script)) { throw "AHWR-EDGE is not installed in $Root." }
    Set-SetupLog (Join-Parts $Root 'logs' 'backup-now.log')
    $start = Get-Date
    Invoke-EdgeScript $script
    $latest = Get-ChildItem -LiteralPath (Join-Path $Root 'backups') -Filter 'records-*.dump' |
        Where-Object { $_.LastWriteTime -ge $start.AddSeconds(-5) } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $latest) { throw 'No new backup file was written.' }
    Write-Host ''
    Write-Host ("BACKUP WRITTEN: {0} ({1:N0} KB)" -f $latest.FullName, ($latest.Length / 1KB)) -ForegroundColor Green
    Write-Host 'Copy it to the asset file server. Restore it with Restore-Records.bat <file>.'
    $code = 0
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
} finally {
    if ($PauseAtEnd) { $null = Read-Host 'Press Enter to close this window' }
}
exit $code
