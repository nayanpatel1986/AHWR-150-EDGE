$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$RunDir = Join-Path $Root 'run'
$DataDir = Join-Path $Root 'data'
$LogDir = Join-Path $Root 'logs'
$SettingsFile = Join-Path $Root 'settings.env'
$Node = Join-Path $Root 'runtime\node\node.exe'
$Python = Join-Path $Root 'runtime\python\python.exe'
$Influxd = Join-Path $Root 'runtime\influx\influxd.exe'
$InfluxCli = Join-Path $Root 'runtime\influx\influx.exe'
$Telegraf = Join-Path $Root 'runtime\telegraf\telegraf.exe'
$Backend = Join-Path $Root 'app\backend\server.js'
$Collector = Join-Path $Root 'app\collector.py'

foreach ($path in @($Node, $Python, $Influxd, $InfluxCli, $Telegraf, $Backend, $Collector)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Missing runtime/application file: $path`nRun Build-AHWR-EDGE.ps1 before starting." }
}
foreach ($dir in @($RunDir, $DataDir, $LogDir, (Join-Path $DataDir 'app'), (Join-Path $DataDir 'influx'))) {
    $null = New-Item -ItemType Directory -Force -Path $dir
}

if (-not (Test-Path -LiteralPath $SettingsFile)) {
    Write-Host 'First-time setup: choose credentials for this computer.' -ForegroundColor Cyan
    $admin = Read-Host 'Local AHWR admin username'
    if ([string]::IsNullOrWhiteSpace($admin)) { $admin = 'admin' }
    $securePassword = Read-Host 'Local AHWR admin password (minimum 8 characters)' -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    try { $adminPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
    if ($adminPassword.Length -lt 8) { throw 'Admin password must be at least 8 characters.' }
    $opcUrl = Read-Host 'KEPServerEX endpoint [opc.tcp://localhost:49320]'
    if ([string]::IsNullOrWhiteSpace($opcUrl)) { $opcUrl = 'opc.tcp://localhost:49320' }
    $opcUser = Read-Host 'KEPServerEX OPC UA username (leave blank if anonymous)'
    $opcPassword = ''
    if (-not [string]::IsNullOrWhiteSpace($opcUser)) {
        $opcSecure = Read-Host 'KEPServerEX OPC UA password' -AsSecureString
        $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($opcSecure)
        try { $opcPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
    }
    $bytes = New-Object byte[] 48
    [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    $token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','A').Replace('/','B')
    $jwtBytes = New-Object byte[] 48
    [Security.Cryptography.RandomNumberGenerator]::Fill($jwtBytes)
    $jwt = [Convert]::ToBase64String($jwtBytes).TrimEnd('=').Replace('+','C').Replace('/','D')
    $settings = @(
        "ADMIN_USERNAME=$admin",
        "ADMIN_PASSWORD=$adminPassword",
        "JWT_SECRET=$jwt",
        "INFLUX_TOKEN=$token",
        'INFLUX_ORG=romii_org',
        'INFLUX_BUCKET=romii_bucket',
        'INFLUX_URL=http://127.0.0.1:8086',
        'PORT=8080',
        "DATA_DIR=$DataDir\app",
        "FRONTEND_DIST_DIR=$Root\app\frontend\dist",
        "TELEGRAF_CONFIG_PATH=$Root\app\telegraf\telegraf.conf",
        'DATA_SOURCE=plc',
        "KEPWARE_OPCUA_URL=$opcUrl",
        "KEPWARE_OPCUA_USERNAME=$opcUser",
        "KEPWARE_OPCUA_PASSWORD=$opcPassword",
        'KEPWARE_SECURITY_MODE=None',
        'KEPWARE_SECURITY_POLICY=None',
        "BOP_CONFIG_PATH=$DataDir\app\bop_config.json",
        'BOP_RECONNECT_INITIAL_SECONDS=2',
        'BOP_RECONNECT_MAX_SECONDS=60',
        'AUTH_MODE=local',
        'SYNC_ENABLED=false',
        'ETP_ENABLED=false'
    )
    Set-Content -LiteralPath $SettingsFile -Value $settings -Encoding UTF8
    Write-Host 'Created settings.env. It contains local service credentials; do not share it.' -ForegroundColor Yellow
}

Get-Content -LiteralPath $SettingsFile | ForEach-Object {
    $line = $_.TrimStart([char]0xFEFF)
    if ($line -match '^\s*([^#=]+)=(.*)$') {
        $key = $matches[1].Trim()
        if ($key -ne 'PATH') {
            [Environment]::SetEnvironmentVariable($key, $matches[2], 'Process')
        }
    }
}

# Keep transferred/offline installs portable. The package may be extracted under
# a different parent folder, so runtime paths must follow this script location.
$env:DATA_DIR = Join-Path $DataDir 'app'
$env:FRONTEND_DIST_DIR = Join-Path $Root 'app\frontend\dist'
$env:TELEGRAF_CONFIG_PATH = Join-Path $Root 'app\telegraf\telegraf.conf'
$env:BOP_CONFIG_PATH = Join-Path $DataDir 'app\bop_config.json'
$env:INFLUX_URL = 'http://127.0.0.1:8086'

function Test-Port([int]$Port) {
    try {
        $client = New-Object Net.Sockets.TcpClient
        $task = $client.ConnectAsync('127.0.0.1', $Port)
        $connected = $task.Wait(500) -and $client.Connected
        $client.Dispose()
        return $connected
    } catch { return $false }
}

function Stop-LegacyAhwrServicesIfNeeded {
    $legacyNames = @('AHWR-Dashboard', 'AHWR-InfluxDB', 'AHWR-Telegraf')
    $legacy = @(Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -in $legacyNames -and
        $_.State -eq 'Running' -and
        ([string]$_.PathName).IndexOf($Root, [StringComparison]::OrdinalIgnoreCase) -lt 0
    })
    if (-not $legacy.Count) { return }

    Write-Host 'A legacy AHWR installation is occupying the required ports:' -ForegroundColor Yellow
    $legacy | ForEach-Object { Write-Host "  $($_.Name): $($_.PathName)" -ForegroundColor Yellow }
    Write-Host 'Windows Administrator approval is required once to stop these legacy services.' -ForegroundColor Cyan

    $helper = Join-Path $Root 'Disable-Legacy-AHWR-Services.ps1'
    if (-not (Test-Path -LiteralPath $helper)) { throw "Missing legacy-service cleanup helper: $helper" }
    $args = @(
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', "`"$helper`"", '-CurrentRoot', "`"$Root`""
    )
    try {
        $elevated = Start-Process -FilePath 'powershell.exe' -ArgumentList $args -Verb RunAs -Wait -PassThru
    } catch {
        throw "Administrator approval was cancelled or failed. Stop the legacy AHWR services and try again. $($_.Exception.Message)"
    }
    if ($elevated.ExitCode -ne 0) { throw "Legacy AHWR service cleanup failed with exit code $($elevated.ExitCode)." }
    Start-Sleep -Seconds 2
}

function Start-ManagedProcess([string]$Name, [string]$File, [string]$Arguments, [string]$WorkingDirectory) {
    $pidFile = Join-Path $RunDir "$Name.pid"
    if (Test-Path -LiteralPath $pidFile) {
        $existingId = 0
        $existingProcess = $null
        if ([int]::TryParse((Get-Content -LiteralPath $pidFile -Raw), [ref]$existingId)) {
            $existingProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$existingId" -ErrorAction SilentlyContinue
        }
        if ($existingProcess -and $existingProcess.ExecutablePath -and $existingProcess.ExecutablePath.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)) {
            Write-Host "$Name is already running (PID $existingId)."
            return
        }
        Remove-Item -LiteralPath $pidFile -Force
    }
    $out = Join-Path $LogDir "$Name.log"
    $err = Join-Path $LogDir "$Name.err.log"
    $proc = Start-Process -FilePath $File -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
    Set-Content -LiteralPath $pidFile -Value $proc.Id -Encoding ASCII
    Write-Host "Started $Name (PID $($proc.Id))."
}

function Assert-PortAvailableOrManaged([int]$Port, [string]$Name) {
    if (-not (Test-Port $Port)) { return }
    $pidFile = Join-Path $RunDir "$Name.pid"
    $managedId = 0
    if ((Test-Path -LiteralPath $pidFile) -and [int]::TryParse((Get-Content -LiteralPath $pidFile -Raw), [ref]$managedId)) {
        $managedProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$managedId" -ErrorAction SilentlyContinue
        if ($managedProcess -and $managedProcess.ExecutablePath -and $managedProcess.ExecutablePath.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)) { return }
    }
    throw "Port $Port is already in use by an unmanaged process. Stop that service and start AHWR-EDGE again."
}
Stop-LegacyAhwrServicesIfNeeded
Assert-PortAvailableOrManaged 8086 'influxdb'
Assert-PortAvailableOrManaged 8888 'telegraf'
Assert-PortAvailableOrManaged 8080 'backend'
Start-ManagedProcess 'influxdb' $Influxd "run --bolt-path `"$DataDir\influx\influxd.bolt`" --engine-path `"$DataDir\influx\engine`" --sqlite-path `"$DataDir\influx\influxd.sqlite`"" $Root

$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    if (Test-Port 8086) { $ready = $true; break }
    Start-Sleep -Seconds 1
}
if (-not $ready) { throw 'InfluxDB did not start. Review logs\influxdb.err.log.' }

try {
    $setupState = Invoke-RestMethod -Uri 'http://127.0.0.1:8086/api/v2/setup' -TimeoutSec 5
    if ($setupState.allowed) {
        $setupBody = @{
            username = 'ahwr_edge_admin'
            password = [guid]::NewGuid().ToString('N') + 'Aa9!'
            org = $env:INFLUX_ORG
            bucket = $env:INFLUX_BUCKET
            token = $env:INFLUX_TOKEN
        } | ConvertTo-Json
        Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8086/api/v2/setup' -ContentType 'application/json' -Body $setupBody -TimeoutSec 30 | Out-Null
        Write-Host 'Initialized the local InfluxDB database.'
    }
} catch { throw "InfluxDB first-run setup failed: $($_.Exception.Message)" }

$backupDir = Join-Path $Root 'migration\influx_backup'
$restoreMarker = Join-Path $Root 'migration\influx_restored.txt'
$backupManifest = if (Test-Path -LiteralPath $backupDir) { Get-ChildItem -LiteralPath $backupDir -Filter '*.manifest' -File | Select-Object -First 1 } else { $null }
if ($backupManifest -and -not (Test-Path -LiteralPath $restoreMarker)) {
    Write-Host 'Restoring the source PC historian and InfluxDB metadata. This may take a few minutes...' -ForegroundColor Cyan
    # A full restore cannot run with org/bucket filters. Remove only these
    # inherited CLI filters for the restore, then restore them for app startup.
    $restoreInfluxOrg = $env:INFLUX_ORG
    $restoreInfluxBucket = $env:INFLUX_BUCKET
    Remove-Item Env:INFLUX_ORG -ErrorAction SilentlyContinue
    Remove-Item Env:INFLUX_BUCKET -ErrorAction SilentlyContinue
    try {
        & $InfluxCli restore --full --operator-token $env:INFLUX_TOKEN --host 'http://127.0.0.1:8086' $backupDir
        $restoreExitCode = $LASTEXITCODE
    } finally {
        if ($null -ne $restoreInfluxOrg) { $env:INFLUX_ORG = $restoreInfluxOrg }
        if ($null -ne $restoreInfluxBucket) { $env:INFLUX_BUCKET = $restoreInfluxBucket }
    }
    if ($restoreExitCode -ne 0) { throw 'InfluxDB historian restore failed. Review the message above; no PLC collectors have been started.' }
    Set-Content -LiteralPath $restoreMarker -Value (Get-Date -Format o) -Encoding ASCII
    Write-Host 'Historian and database metadata restored.' -ForegroundColor Green
}

$retentionSeconds = 180 * 24 * 60 * 60
try {
    $bucketInfo = Invoke-RestMethod -Uri "$env:INFLUX_URL/api/v2/buckets?name=$([uri]::EscapeDataString($env:INFLUX_BUCKET))" -Headers @{ Authorization = "Token $env:INFLUX_TOKEN" } -TimeoutSec 10
    $bucket = $bucketInfo.buckets | Select-Object -First 1
    if ($bucket -and $bucket.id) {
        $retentionBody = @{
            retentionRules = @(@{
                type = 'expire'
                everySeconds = $retentionSeconds
            })
        } | ConvertTo-Json -Depth 5
        Invoke-RestMethod -Method Patch -Uri "$env:INFLUX_URL/api/v2/buckets/$($bucket.id)" -Headers @{ Authorization = "Token $env:INFLUX_TOKEN" } -ContentType 'application/json' -Body $retentionBody -TimeoutSec 10 | Out-Null
        Write-Host "InfluxDB bucket '$env:INFLUX_BUCKET' retention set to 180 days."
    }
} catch {
    Write-Host "Warning: could not update InfluxDB retention to 180 days: $($_.Exception.Message)" -ForegroundColor Yellow
}

$env:INFLUX_URL = 'http://127.0.0.1:8086'
$env:INFLUX_TOKEN = [Environment]::GetEnvironmentVariable('INFLUX_TOKEN', 'Process')
$env:INFLUX_ORG = [Environment]::GetEnvironmentVariable('INFLUX_ORG', 'Process')
$env:INFLUX_BUCKET = [Environment]::GetEnvironmentVariable('INFLUX_BUCKET', 'Process')
Start-ManagedProcess 'telegraf' $Telegraf "--config `"$Root\app\telegraf\telegraf.conf`" --config-directory `"$Root\app\telegraf\telegraf.d`" --watch-config=poll" (Join-Path $Root 'app\telegraf')
Start-ManagedProcess 'backend' $Node "`"$Backend`"" (Join-Path $Root 'app\backend')

$backendReady = $false
for ($i = 0; $i -lt 45; $i++) {
    try { $null = Invoke-RestMethod 'http://127.0.0.1:8080/healthz' -TimeoutSec 2; $backendReady = $true; break } catch { Start-Sleep -Seconds 1 }
}
if (-not $backendReady) { throw 'AHWR backend did not start. Review logs\backend.err.log.' }

# The initial password is only needed once to seed the app user store; remove it
# from the environment file after the first successful initialization.
$settingsContent = Get-Content -LiteralPath $SettingsFile -Raw
if ($settingsContent -match '(?m)^ADMIN_PASSWORD=') {
    $settingsContent = [regex]::Replace($settingsContent, '(?m)^ADMIN_PASSWORD=.*(?:\r?\n|$)', '')
    Set-Content -LiteralPath $SettingsFile -Value $settingsContent.TrimEnd() -Encoding UTF8
}

Start-ManagedProcess 'bop-collector' $Python "`"$Collector`"" (Join-Path $Root 'app')

$lanIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.AddressState -eq 'Preferred' } | Select-Object -First 1 -ExpandProperty IPAddress)
Write-Host ''
Write-Host 'AHWR-EDGE is running.' -ForegroundColor Green
Write-Host 'This PC: http://localhost:8080'
if ($lanIp) { Write-Host "Other PCs on this LAN: http://${lanIp}:8080" }
Write-Host 'Allow Windows Firewall access on the Private network if prompted.'
Start-Process 'http://localhost:8080'
