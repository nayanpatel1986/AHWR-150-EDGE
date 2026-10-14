# Repeats the installer's self-test: services, database, PLC readings, web UI,
# firewall, backup task, upload to the CMF and time. Writes logs\health-<time>.html.
# Windows PowerShell 5.1.
param([switch]$PauseAtEnd)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
Import-Module (Join-Path $PSScriptRoot 'AhwrSetup.psm1') -Force -DisableNameChecking
if (-not (Test-IsAdministrator)) { Restart-Elevated $PSCommandPath }

$Root = Get-AhwrInstallRoot
$code = 1
$outcome = 'PROBLEMS FOUND'
$report = Join-Parts $Root 'logs' ('health-{0:yyyyMMdd-HHmmss}.html' -f (Get-Date))
try {
    if (-not (Test-Path -LiteralPath (Join-Path $Root 'settings.env'))) { throw "AHWR-EDGE is not installed in $Root." }
    Set-SetupLog (Join-Parts $Root 'logs' 'health.log')
    Invoke-Stage 1 1 'Self-test' { Invoke-SelfTest $Root }
    $warnings = @(Get-CheckResults | Where-Object { $_.Status -eq 'WARNING' }).Count
    $outcome = 'HEALTHY'
    if ($warnings) { $outcome = "HEALTHY WITH $warnings WARNING(S)" }
    $code = 0
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
} finally {
    $settings = Read-EnvFile (Join-Path $Root 'settings.env')
    $facts = [ordered]@{ 'Computer' = $env:COMPUTERNAME }
    if ($settings.Contains('DEVICE_ID')) { $facts['Rig (DeviceId)'] = $settings['DEVICE_ID'] }
    $info = Read-InstallInfo $Root
    if ($info) { $facts['Installed version'] = $info.version }
    if (Test-Path -LiteralPath (Join-Path $Root 'logs')) {
        Write-SetupReport $report 'AHWR-150 EDGE health check' $outcome $facts
        Write-Host "Report: $report"
    }
    Write-Host ''
    $color = 'Green'
    if ($code -ne 0) { $color = 'Red' } elseif ($outcome -ne 'HEALTHY') { $color = 'Yellow' }
    Write-Host $outcome -ForegroundColor $color
    if ($PauseAtEnd) { $null = Read-Host 'Press Enter to close this window' }
}
exit $code
