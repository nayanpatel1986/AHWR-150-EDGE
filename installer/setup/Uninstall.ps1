# Removes the AHWR-EDGE services, programs, firewall rules and scheduled tasks.
# Keeps the data (database, records, upload buffer, logs, backups) and a copy of
# the settings in <data drive>\AHWR\kept-config, so a reinstall with the same
# DeviceId continues with the same database. /purge also deletes the data, after
# a typed confirmation. Usage: Uninstall.bat [/purge]   Windows PowerShell 5.1.
param([Parameter(Position = 0)][string]$Option = '', [switch]$PauseAtEnd)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
Import-Module (Join-Path $PSScriptRoot 'AhwrSetup.psm1') -Force -DisableNameChecking
if (-not (Test-IsAdministrator)) {
    $pass = @()
    if ($Option) { $pass = @($Option) }
    Restart-Elevated $PSCommandPath $pass
}
Set-Location -LiteralPath $env:TEMP   # the tools folder is deleted below

$Root = Get-AhwrInstallRoot
$purge = $Option -match '^[/-](?i)purge$'
$code = 1
try {
    if ($Option -and -not $purge) { throw "Unknown option '$Option'. Usage: Uninstall.bat [/purge]" }
    if (-not (Test-Path -LiteralPath $Root)) { throw "AHWR-EDGE is not installed in $Root." }
    $settings = Read-EnvFile (Join-Path $Root 'settings.env')
    $rig = '(unknown)'
    if ($settings.Contains('DEVICE_ID')) { $rig = $settings['DEVICE_ID'] }
    $info = Read-InstallInfo $Root
    $dataRoot = $Root
    if ($info -and $info.dataRoot) { $dataRoot = [string]$info.dataRoot }

    Write-Host "This removes AHWR-EDGE (rig $rig) from this PC: services, programs in $Root, firewall rules and scheduled tasks." -ForegroundColor Yellow
    if ($purge) { Write-Host "/purge: ALL DATA in $dataRoot is deleted as well (database, records, upload buffer, logs, backups)." -ForegroundColor Red }
    else { Write-Host "The data in $dataRoot is kept." }
    if ((Read-Host 'Type UNINSTALL to continue') -cne 'UNINSTALL') { throw 'Cancelled; nothing was changed.' }
    if ($purge -and (Read-Host "Type the rig DeviceId ($rig) to confirm deleting its data") -cne $rig) { throw 'DeviceId did not match; nothing was changed.' }

    $removeServices = Join-Path $Root 'Remove-AHWR-EDGE-Services.ps1'
    if (Test-Path -LiteralPath $removeServices) { Invoke-EdgeScript $removeServices @('-NssmPath', (Join-Parts $Root 'runtime' 'nssm' 'nssm.exe')) }
    $stop = Join-Path $Root 'Stop-AHWR-EDGE.ps1'
    if (Test-Path -LiteralPath $stop) { try { Invoke-EdgeScript $stop @('-All') } catch { Write-Host "Note: $($_.Exception.Message)" -ForegroundColor Yellow } }
    Write-Host 'Services removed.'
    Unregister-ScheduledTask -TaskName 'AHWR-EDGE log cleanup' -Confirm:$false -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName 'AHWR-EDGE records backup' -Confirm:$false -ErrorAction SilentlyContinue
    Get-NetFirewallRule -Group $AhwrFirewallGroup -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    Write-Host 'Scheduled tasks and firewall rules removed.'

    if (-not $purge) {
        $kept = Join-Path $dataRoot 'kept-config'
        $null = New-Item -ItemType Directory -Force -Path $kept
        foreach ($f in @((Join-Path $Root 'settings.env'), (Join-Parts $Root 'config' 'rig-settings.ini'), (Join-Parts $Root 'config' 'install.json'), (Join-Parts $Root 'certs' 'ongc-ca.crt'))) {
            if (Test-Path -LiteralPath $f) { Copy-Item -LiteralPath $f -Destination $kept -Force }
        }
        Write-Host "Settings kept in $kept (needed to open the kept database after a reinstall)."
    }

    if ($dataRoot -ine $Root) {
        foreach ($name in @('data', 'logs', 'backups')) { Remove-DataJunction (Join-Path $Root $name) }
        $links = @(Get-ChildItem -LiteralPath $Root -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue)
        foreach ($l in $links) { & cmd.exe /c rmdir "$($l.FullName)" | Out-Null }
        Remove-Item -LiteralPath $Root -Recurse -Force
        Write-Host "Programs removed ($Root)."
        if ($purge) { Remove-Item -LiteralPath $dataRoot -Recurse -Force; Write-Host "Data removed ($dataRoot)." }
    } elseif ($purge) {
        Remove-Item -LiteralPath $Root -Recurse -Force
        Write-Host "Programs and data removed ($Root)."
    } else {
        foreach ($item in @(Get-ChildItem -LiteralPath $Root -Force)) {
            if ($item.Name -in @('data', 'logs', 'backups', 'kept-config')) { continue }
            Remove-Item -LiteralPath $item.FullName -Recurse -Force
        }
        Write-Host "Programs removed; data kept in $Root\data, logs, backups."
    }
    Write-Host ''
    Write-Host 'AHWR-EDGE UNINSTALLED' -ForegroundColor Green
    $code = 0
} catch {
    Write-Host ''
    Write-Host $_.Exception.Message -ForegroundColor Red
} finally {
    if ($PauseAtEnd) { $null = Read-Host 'Press Enter to close this window' }
}
exit $code
