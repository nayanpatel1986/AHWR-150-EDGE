# Zips the logs, reports, service state and settings (passwords, tokens and keys
# removed) to the desktop, for the application support team. Windows PowerShell 5.1.
param([switch]$PauseAtEnd)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
Import-Module (Join-Path $PSScriptRoot 'AhwrSetup.psm1') -Force -DisableNameChecking
if (-not (Test-IsAdministrator)) { Restart-Elevated $PSCommandPath }

$Root = Get-AhwrInstallRoot
$code = 1
$secretKey = '(?i)(PASSWORD|SECRET|TOKEN|KEY)'
try {
    $settings = Read-EnvFile (Join-Path $Root 'settings.env')
    $rig = 'unknown-rig'
    if ($settings.Contains('DEVICE_ID') -and $settings['DEVICE_ID']) { $rig = $settings['DEVICE_ID'] }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $work = Join-Path $env:TEMP "AHWR-logs-$rig-$stamp"
    $null = New-Item -ItemType Directory -Force -Path $work

    # Logs of the last 14 days (service logs are copied while the services keep writing them).
    $since = (Get-Date).AddDays(-14)
    foreach ($pair in @(@((Join-Path $Root 'logs'), 'logs'), @((Join-Parts $Root 'data' 'pgdata' 'log'), 'postgresql'))) {
        if (-not (Test-Path -LiteralPath $pair[0])) { continue }
        $base = (Resolve-Path -LiteralPath $pair[0]).Path.TrimEnd('\')
        foreach ($f in @(Get-ChildItem -LiteralPath $pair[0] -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -ge $since })) {
            $dest = Join-Parts $work $pair[1] $f.FullName.Substring($base.Length).TrimStart('\')
            $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest)
            try { Copy-SharedFile $f.FullName $dest } catch { Add-Content -LiteralPath (Join-Path $work 'not-collected.txt') -Value "$($f.FullName): $($_.Exception.Message)" }
        }
    }

    $redacted = foreach ($key in $settings.Keys) { if ($key -match $secretKey) { "$key=***" } else { "$key=$($settings[$key])" } }
    Write-Utf8File (Join-Path $work 'settings-redacted.env') @($redacted)
    $ini = Join-Parts $Root 'config' 'rig-settings.ini'
    if (Test-Path -LiteralPath $ini) {
        $lines = foreach ($l in [IO.File]::ReadAllLines($ini)) { if ($l -match '^\s*([^=;#]*(Password|Token)[^=]*)=') { "$($matches[1])= ***" } else { $l } }
        Write-Utf8File (Join-Path $work 'rig-settings-redacted.ini') @($lines)
    }
    foreach ($f in @((Join-Parts $Root 'config' 'install.json'), (Join-Parts $Root 'runtime' 'components.json'))) {
        if (Test-Path -LiteralPath $f) { Copy-Item -LiteralPath $f -Destination $work }
    }

    $os = Get-CimInstance Win32_OperatingSystem
    $info = @(
        "Computer: $env:COMPUTERNAME", "Collected: $(Get-Date -Format o)", "Windows: $($os.Caption) build $($os.BuildNumber)",
        "Last boot: $($os.LastBootUpTime)", "Time zone: $((Get-TimeZone).Id)", '', 'Disks:')
    $info += @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { '  {0} {1:N0} GB free of {2:N0} GB' -f $_.DeviceID, ($_.FreeSpace / 1GB), ($_.Size / 1GB) })
    $info += @('', 'Services:')
    $info += @(Get-CimInstance Win32_Service | Where-Object { $_.Name -like 'AHWR*' } | ForEach-Object { '  {0,-20} {1,-8} {2,-7} {3}' -f $_.Name, $_.State, $_.StartMode, $_.PathName })
    $info += @('', 'Listening ports:')
    $info += @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in @(5432, 8080, 8186, 8888) } | ForEach-Object { '  {0}:{1} pid {2}' -f $_.LocalAddress, $_.LocalPort, $_.OwningProcess })
    $info += @('', 'Firewall rules (AHWR-EDGE):')
    $info += @(Get-NetFirewallRule -Group $AhwrFirewallGroup -ErrorAction SilentlyContinue | ForEach-Object { '  {0} {1} {2}' -f $_.DisplayName, $_.Action, $_.Enabled })
    Write-Utf8File (Join-Path $work 'system.txt') $info

    Set-SetupLog (Join-Path $work 'health.log')
    try { Invoke-SelfTest $Root } catch { Add-Check 'Self-test' 'FAILED' $_.Exception.Message }
    Write-SetupReport (Join-Path $work 'health.html') 'AHWR-150 EDGE health check' 'collected for support' ([ordered]@{ 'Rig (DeviceId)' = $rig })

    $zip = Join-Path ([Environment]::GetFolderPath('Desktop')) "AHWR-logs-$rig-$stamp.zip"
    Compress-Archive -Path (Join-Path $work '*') -DestinationPath $zip -Force
    Remove-Item -LiteralPath $work -Recurse -Force
    Write-Host ''
    Write-Host "LOGS COLLECTED: $zip" -ForegroundColor Green
    Write-Host 'Passwords, tokens and keys are left out. Send this zip to the application support team.'
    $code = 0
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
} finally {
    if ($PauseAtEnd) { $null = Read-Host 'Press Enter to close this window' }
}
exit $code
