param(
    # NSSM service wrapper (win64\nssm.exe from NSSM 2.24). Default: runtime\nssm\nssm.exe or tools\nssm.exe.
    [string]$NssmPath,
    # Account for Telegraf, the backend and the BOP collector. The default is the
    # built-in low-privilege LocalService; a local account such as .\svc-ahwr also works.
    [string]$ServiceUser = 'NT AUTHORITY\LocalService',
    [securestring]$ServicePassword,
    # Daily records backup time (HH:mm); empty to skip the scheduled task.
    [string]$BackupTime = '02:30'
)
$ErrorActionPreference = 'Stop'
# Registers AHWR-EDGE as Windows services that start at boot (no sign-in needed)
# and restart automatically whenever they stop:
#   AHWR-PostgreSQL     bundled PostgreSQL + TimescaleDB (PG_MODE=bundled)
#   AHWR-Telegraf       PLC (read-only) and BOP collection -> TimescaleDB
#   AHWR-Backend        HMI, API, CMF sync and ETP
#   AHWR-BOP-Collector  VersaMax / KEPServerEX OPC UA -> Telegraf
# Run once in an elevated PowerShell after Start-AHWR-EDGE.bat has completed a
# first start. Re-running it updates the services.
#
# The backend and the collector read settings.env when they start (SETTINGS_FILE),
# so secrets are not copied into the service registry and settings changes apply
# on the next service restart. Telegraf receives only its insert-only database
# password.
$Root = $PSScriptRoot
$SettingsFile = Join-Path $Root 'settings.env'
$LogDir = Join-Path $Root 'logs'
$RunDir = Join-Path $Root 'run'
$Node = Join-Path $Root 'runtime\node\node.exe'
$Python = Join-Path $Root 'runtime\python\python.exe'
$Telegraf = Join-Path $Root 'runtime\telegraf\telegraf.exe'
$PgBin = Join-Path $Root 'runtime\pgsql\bin'
$PgData = Join-Path $Root 'data\pgdata'
$ServiceNames = @('AHWR-Telegraf', 'AHWR-Backend', 'AHWR-BOP-Collector')

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this script in an elevated (Administrator) PowerShell.' }
if (-not (Test-Path -LiteralPath $SettingsFile)) { throw 'settings.env not found. Run Start-AHWR-EDGE.bat once first.' }
if (-not $NssmPath) {
    $NssmPath = @((Join-Path $Root 'runtime\nssm\nssm.exe'), (Join-Path $Root 'tools\nssm.exe')) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $NssmPath -or -not (Test-Path -LiteralPath $NssmPath)) { throw 'nssm.exe not found. Copy win64\nssm.exe from NSSM 2.24 to runtime\nssm\ or pass -NssmPath.' }
foreach ($path in @($Node, $Python, $Telegraf)) { if (-not (Test-Path -LiteralPath $path)) { throw "Missing runtime file: $path" } }
foreach ($dir in @($LogDir, $RunDir)) { $null = New-Item -ItemType Directory -Force -Path $dir }

$settings = @{}
Get-Content -LiteralPath $SettingsFile | ForEach-Object {
    $line = $_.TrimStart([char]0xFEFF)
    if ($line -match '^\s*([^#=]+)=(.*)$') { $settings[$matches[1].Trim()] = $matches[2] }
}
foreach ($key in @('DEVICE_ID', 'PGPASSWORD', 'TELEGRAF_DB_PASSWORD')) { if (-not $settings[$key]) { throw "settings.env has no $key. Run Start-AHWR-EDGE.bat once first." } }
if ($settings.ContainsKey('ADMIN_PASSWORD')) { throw 'settings.env still holds ADMIN_PASSWORD: complete a first start with Start-AHWR-EDGE.bat before installing the services.' }
$pgMode = if ($settings['PG_MODE']) { $settings['PG_MODE'] } else { 'bundled' }

# Telegraf 1.32+ keeps retrying a PLC that is unreachable at start; older
# releases exit, and NSSM restarts them.
$telegrafRetry = 'false'
$tv = (& $Telegraf --version) -join ' '
if ($tv -match 'Telegraf v?(\d+)\.(\d+)' -and ([int]$matches[1] -gt 1 -or [int]$matches[2] -ge 32)) { $telegrafRetry = 'true' }

# Stop the portable (non-service) processes so the ports are free.
& (Join-Path $Root 'Stop-AHWR-EDGE.ps1') -All | Out-Null

# --- Service account and folder rights -----------------------------------------
$plainPassword = ''
if ($ServiceUser -notmatch '^NT AUTHORITY\\(LocalService|NetworkService)$') {
    if (-not $ServicePassword) { $ServicePassword = Read-Host "Password for $ServiceUser" -AsSecureString }
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ServicePassword)
    try { $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
& icacls $Root /grant "${ServiceUser}:(OI)(CI)RX" /C /Q | Out-Null
# Written by the services: records/sync buffer, logs, and the managed Telegraf config.
foreach ($dir in @((Join-Path $Root 'data\app'), $LogDir, (Join-Path $Root 'app\telegraf\telegraf.d'))) {
    & icacls $dir /grant "${ServiceUser}:(OI)(CI)M" /T /C /Q | Out-Null
}

# --- PostgreSQL ------------------------------------------------------------------
if ($pgMode -eq 'bundled') {
    $pgService = 'AHWR-PostgreSQL'
    $pgCtl = Join-Path $PgBin 'pg_ctl.exe'
    $pgConf = Join-Path $PgData 'postgresql.conf'
    if (-not (Test-Path -LiteralPath (Join-Path $PgData 'PG_VERSION'))) { throw 'data\pgdata is not initialised. Run Start-AHWR-EDGE.bat once first.' }
    if (Get-Service $pgService -ErrorAction SilentlyContinue) {
        Stop-Service $pgService -Force -ErrorAction SilentlyContinue
        & $pgCtl unregister -N $pgService | Out-Null
    }
    # A service has no console: keep PostgreSQL's own log files in data\pgdata\log.
    if (-not (Select-String -LiteralPath $pgConf -Pattern '^\s*logging_collector\s*=' -Quiet)) {
        Add-Content -LiteralPath $pgConf -Encoding ASCII -Value @(
            '', '# AHWR-150 EDGE: log files when running as a Windows service',
            'logging_collector = on', "log_directory = 'log'", "log_filename = 'postgresql-%a.log'",
            'log_truncate_on_rotation = on', 'log_rotation_age = 1d', 'log_rotation_size = 0'
        )
    }
    & icacls $PgData /grant 'NT AUTHORITY\NetworkService:(OI)(CI)F' /T /C /Q | Out-Null
    & $pgCtl register -N $pgService -U 'NT AUTHORITY\NetworkService' -D $PgData -S auto -w -t 120
    if ($LASTEXITCODE -ne 0) { throw 'pg_ctl register failed.' }
    & sc.exe failure $pgService reset= 86400 actions= restart/10000/restart/10000/restart/60000 | Out-Null
    & sc.exe failureflag $pgService 1 | Out-Null
    Start-Service $pgService
    Write-Host "Registered $pgService (PostgreSQL + TimescaleDB, data\pgdata)."
} else {
    $pgService = if ($settings['PG_SERVICE_NAME']) { $settings['PG_SERVICE_NAME'] } else { 'postgresql-x64-18' }
    if (-not (Get-Service $pgService -ErrorAction SilentlyContinue)) { throw "PostgreSQL service '$pgService' not found. Set PG_SERVICE_NAME in settings.env." }
    Set-Service $pgService -StartupType Automatic
}

# --- Telegraf, backend, BOP collector (NSSM) --------------------------------------
function Set-Nssm([string]$Name, [string]$Parameter) {
    & $NssmPath set $Name $Parameter @args | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "nssm set $Name $Parameter failed." }
}

function Install-NssmService([string]$Name, [string]$Exe, [string]$Arguments, [string]$Directory, [string[]]$Environment, [string[]]$DependsOn) {
    if (Get-Service $Name -ErrorAction SilentlyContinue) {
        & $NssmPath stop $Name | Out-Null
        & $NssmPath remove $Name confirm | Out-Null
    }
    & $NssmPath install $Name $Exe $Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "nssm install $Name failed." }
    $log = Join-Path $LogDir "$Name.log"
    Set-Nssm $Name AppDirectory $Directory
    Set-Nssm $Name AppEnvironmentExtra @Environment
    Set-Nssm $Name DependOnService @DependsOn
    Set-Nssm $Name DisplayName "AHWR-EDGE $($Name.Substring(5))"
    Set-Nssm $Name Start SERVICE_AUTO_START
    Set-Nssm $Name AppExit Default Restart
    Set-Nssm $Name AppRestartDelay 5000
    Set-Nssm $Name AppThrottle 10000
    # Ctrl+C first, with time for the backend to flush records to the database.
    Set-Nssm $Name AppStopMethodConsole 15000
    Set-Nssm $Name AppKillProcessTree 1
    Set-Nssm $Name AppStdout $log
    Set-Nssm $Name AppStderr $log
    Set-Nssm $Name AppRotateFiles 1
    Set-Nssm $Name AppRotateOnline 1
    Set-Nssm $Name AppRotateBytes 10485760
    if ($plainPassword) { Set-Nssm $Name ObjectName $ServiceUser $plainPassword } else { Set-Nssm $Name ObjectName $ServiceUser }
    & $NssmPath start $Name | Out-Null
    Write-Host "Registered $Name."
}

$pgEnv = @("PGHOST=$(if ($settings['PGHOST']) { $settings['PGHOST'] } else { '127.0.0.1' })",
    "PGPORT=$(if ($settings['PGPORT']) { $settings['PGPORT'] } else { '5432' })",
    "PGDATABASE=$(if ($settings['PGDATABASE']) { $settings['PGDATABASE'] } else { 'ahwr_edge' })")
$paths = @("SETTINGS_FILE=$SettingsFile", "DATA_DIR=$Root\data\app", "FRONTEND_DIST_DIR=$Root\app\frontend\dist",
    "TELEGRAF_CONFIG_PATH=$Root\app\telegraf\telegraf.d\plc.conf", "BOP_CONFIG_PATH=$Root\data\app\bop_config.json",
    'TELEGRAF_LISTENER_URL=http://127.0.0.1:8186')
# Node reads NODE_EXTRA_CA_CERTS (e.g. the company CA for the CMF and LDAPS) only
# at process start, so it must be in the service environment, not just settings.env.
if ($settings['NODE_EXTRA_CA_CERTS']) { $paths += "NODE_EXTRA_CA_CERTS=$($settings['NODE_EXTRA_CA_CERTS'])" }

# Arguments are relative to each AppDirectory: no quoting, whatever the install path.
Install-NssmService 'AHWR-Telegraf' $Telegraf '--config telegraf.conf --config-directory telegraf.d --watch-config poll' `
    (Join-Path $Root 'app\telegraf') (@("TELEGRAF_DB_PASSWORD=$($settings['TELEGRAF_DB_PASSWORD'])") + $pgEnv) @($pgService)
Install-NssmService 'AHWR-Backend' $Node 'server.js' (Join-Path $Root 'app\backend') `
    ($paths + @("TELEGRAF_STARTUP_RETRY=$telegrafRetry", 'NODE_ENV=production')) @($pgService)
Install-NssmService 'AHWR-BOP-Collector' $Python 'collector.py' (Join-Path $Root 'app') $paths @('AHWR-Telegraf')

if ($BackupTime) {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Root\Backup-AHWR-EDGE-Records.ps1`""
    $trigger = New-ScheduledTaskTrigger -Daily -At $BackupTime
    Register-ScheduledTask -TaskName 'AHWR-EDGE records backup' -Action $action -Trigger $trigger -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
    Write-Host "Scheduled the daily records backup at $BackupTime (backups\)."
}
Set-Content -LiteralPath (Join-Path $RunDir 'services.installed') -Value (Get-Date -Format o) -Encoding ASCII

# The logon shortcut is not needed once the services start at boot.
$shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'AHWR-EDGE.lnk'
if (Test-Path -LiteralPath $shortcut) { Write-Host "Note: the logon shortcut $shortcut now only opens the dashboard; Remove-AHWR-EDGE-Autostart.ps1 removes it." }

Write-Host ''
Write-Host 'AHWR-EDGE now runs as Windows services: they start at boot and restart if they stop.' -ForegroundColor Green
Write-Host "Telegraf: $tv (startup retry for an unreachable PLC: $telegrafRetry)."
Write-Host 'Start-AHWR-EDGE.bat checks the services and opens the dashboard; Stop-AHWR-EDGE.bat stops collection.'
Write-Host 'Logs: logs\AHWR-*.log and data\pgdata\log. Remove the services with Remove-AHWR-EDGE-Services.ps1.'
