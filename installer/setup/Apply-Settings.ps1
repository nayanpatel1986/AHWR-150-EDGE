# Re-applies C:\AHWR\config\rig-settings.ini after a change (CMF address or
# token, domain login, rig LAN subnet, BOP endpoint, CA certificate).
# DeviceId and DataDrive cannot change after installation. Windows PowerShell 5.1.
param([switch]$PauseAtEnd)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
Import-Module (Join-Path $PSScriptRoot 'AhwrSetup.psm1') -Force -DisableNameChecking
if (-not (Test-IsAdministrator)) { Restart-Elevated $PSCommandPath }

$Root = Get-AhwrInstallRoot
$IniPath = Join-Parts $Root 'config' 'rig-settings.ini'
$SettingsPath = Join-Path $Root 'settings.env'
$state = @{ Values = $null; Existing = $null; CaPem = ''; CaChanged = $false }
$code = 1
try {
    if (-not (Test-Path -LiteralPath $SettingsPath)) { throw "AHWR-EDGE is not installed in $Root." }
    Set-SetupLog (Join-Parts $Root 'logs' 'apply-settings.log')
    Invoke-Stage 1 3 'Check settings' {
        $state.Existing = Read-EnvFile $SettingsPath
        $check = Test-RigSettings (Read-IniFile $IniPath) $state.Existing
        foreach ($e in $check.Errors) { Add-Check 'rig-settings.ini' 'FAILED' $e }
        foreach ($w in $check.Warnings) { Add-Check 'rig-settings.ini' 'WARNING' $w }
        if ($check.Errors.Count) { return }
        $v = $check.Values
        $state.Values = $v
        if ($v.DeviceId -ne $state.Existing['DEVICE_ID']) { Add-Check 'DeviceId' 'FAILED' "this PC is rig '$($state.Existing['DEVICE_ID'])'; DeviceId never changes after installation"; return }
        $info = Read-InstallInfo $Root
        if ($info -and $info.dataRoot -and -not ([string]$info.dataRoot).StartsWith($v.DataDrive, [StringComparison]::OrdinalIgnoreCase)) {
            Add-Check 'DataDrive' 'FAILED' "the data is on $($info.dataRoot); DataDrive cannot change after installation"; return
        }
        $crt = Join-Parts $Root 'certs' 'ongc-ca.crt'
        if (Test-Path -LiteralPath $crt) {
            $pem = Join-Parts $Root 'certs' 'ongc-ca.pem'
            $before = ''
            if (Test-Path -LiteralPath $pem) { $before = (Get-FileHash -LiteralPath $pem).Hash }
            $cert = ConvertTo-PemCertificate $crt $pem
            $state.CaPem = $pem
            $state.CaChanged = ($before -ne (Get-FileHash -LiteralPath $pem).Hash) -or ($state.Existing['NODE_EXTRA_CA_CERTS'] -ne $pem)
            Add-Check 'CA certificate' 'OK' "$($cert.Subject), valid until $($cert.NotAfter.ToString('yyyy-MM-dd'))"
        }
        Add-Check 'Values' 'OK' "rig $($v.DeviceId)"
    }
    Invoke-Stage 2 3 'Apply' {
        $updates = ConvertTo-EdgeSettings $state.Values $state.Existing $Root $state.CaPem
        Update-EnvFile $SettingsPath $updates
        Add-Check 'Settings file' 'OK' 'updated'
        $null = Set-HmiFirewall $state.Values.RigLanSubnet (Join-Parts $Root 'runtime' 'node' 'node.exe')
        Add-Check 'Firewall' 'OK' "port 8080 open to $($state.Values.RigLanSubnet -join ', ') only"
        if ($state.CaChanged) {
            # The CA path is part of the service environment: register the services again.
            Invoke-EdgeScript (Join-Path $Root 'Install-AHWR-EDGE-Services.ps1') @('-NssmPath', (Join-Parts $Root 'runtime' 'nssm' 'nssm.exe'), '-BackupTime', '02:30')
            Add-Check 'Services' 'OK' 'registered again with the new CA certificate'
        } else {
            Stop-AhwrServices @('AHWR-BOP-Collector', 'AHWR-Backend')
            Start-AhwrServices @('AHWR-Backend', 'AHWR-BOP-Collector')
            Add-Check 'Services' 'OK' 'AHWR-Backend and AHWR-BOP-Collector restarted'
        }
        $cleared = @(Clear-IniSecrets $IniPath)
        if ($cleared.Count) { Add-Check 'Secrets' 'INFO' ('stored in the protected settings and blanked in rig-settings.ini: ' + ($cleared -join ', ')) }
    }
    Invoke-Stage 3 3 'Self-test' { Invoke-SelfTest $Root }
    $code = 0
    Write-Host ''
    Write-Host 'SETTINGS APPLIED' -ForegroundColor Green
} catch {
    Write-Host ''
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host 'Correct rig-settings.ini and run Apply-Settings.bat again.' -ForegroundColor Yellow
} finally {
    if ($PauseAtEnd) { $null = Read-Host 'Press Enter to close this window' }
}
exit $code
