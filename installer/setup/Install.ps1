# AHWR-150 EDGE single-click installer (run through Install.bat).
# Ten stages as in the Edge Installation Guide; stops at the first failed stage
# and can be run again: an installed PC is repaired, keeping its database,
# records and settings. Windows PowerShell 5.1; ASCII only.
param([switch]$PauseAtEnd)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$SetupDir = $PSScriptRoot
$PackageRoot = Split-Path -Parent $SetupDir
Import-Module (Join-Path $SetupDir 'AhwrSetup.psm1') -Force -DisableNameChecking
if (-not (Test-IsAdministrator)) { Restart-Elevated $PSCommandPath }

$Total = 10
$Root = Get-AhwrInstallRoot
$Version = (Get-Content -LiteralPath (Join-Path $PackageRoot 'VERSION.txt') -Raw).Trim()
$IniPath = Join-Path $PackageRoot 'rig-settings.ini'
$ComponentsDir = Join-Path $PackageRoot 'components'
$AppSource = Join-Path $PackageRoot 'app'
$Components = @{}
foreach ($c in (Read-ComponentManifest (Join-Path $ComponentsDir 'components.json'))) { $Components[$c.name] = $c }
$state = @{ Repair = $false; Fresh = $false; AdminPassword = $null; DataRoot = $null; Values = $null; Settings = $null; Ini = $null; RamGb = 16; KeptConfig = $null }
Set-SetupLog (Join-Path $env:TEMP 'AHWR-install.log')

function Install-ZipComponent([string]$Name, [string]$Target, [string[]]$Only = @()) {
    # Unpack one bundled component unless the same file is already installed.
    $c = $Components[$Name]
    if (-not $c) { throw "components.json does not list $Name." }
    $installed = Get-InstalledComponents $Root
    if ($installed.ContainsKey($Name) -and $installed[$Name] -eq $c.sha256 -and (Test-Path -LiteralPath $Target)) { return $false }
    $tmp = "$Target.new"
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
    Expand-ZipTo (Join-Path $ComponentsDir $c.file) $tmp $c.strip @() $Only
    if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force }
    Rename-Item -LiteralPath $tmp -NewName (Split-Path -Leaf $Target)
    Set-InstalledComponent $Root $Name $c.sha256
    return $true
}

function Get-LanAddress {
    $ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.AddressState -eq 'Preferred' } |
        Select-Object -First 1 -ExpandProperty IPAddress
    if ($ip) { return $ip }
    return 'localhost'
}

$outcome = 'INSTALLATION FAILED'
$exitCode = 1
Write-Host ''
Write-Host "AHWR-150 EDGE installer $Version" -ForegroundColor Cyan
Write-Host 'Do not close this window or restart the PC while it runs.'
try {
    # ------------------------------------------------------------------ 1
    Invoke-Stage 1 $Total 'Pre-checks' {
        Add-Check 'Administrator rights' 'OK' (Get-CurrentUserName)
        $os = Get-CimInstance Win32_OperatingSystem
        if (-not [Environment]::Is64BitOperatingSystem) { Add-Check 'Windows' 'FAILED' 'a 64-bit Windows is required' }
        elseif ([int]$os.BuildNumber -lt 17763) { Add-Check 'Windows' 'FAILED' "$($os.Caption) build $($os.BuildNumber): Windows 10 1809 or later is required" }
        elseif ($os.Caption -match 'Home') { Add-Check 'Windows' 'WARNING' "$($os.Caption): Windows 10/11 IoT Enterprise LTSC or Pro is expected" }
        else { Add-Check 'Windows' 'OK' "$($os.Caption) build $($os.BuildNumber)" }

        try { $state.Ini = Read-IniFile $IniPath } catch { Add-Check 'rig-settings.ini' 'FAILED' $_.Exception.Message; return }
        $strict = (Get-IniValue $state.Ini 'Install' 'Checks' 'strict') -ne 'relaxed'
        $short = 'WARNING'
        if ($strict) { $short = 'FAILED' }

        $cores = [Environment]::ProcessorCount
        if ($cores -lt 4) { Add-Check 'Processor' $short "$cores logical processors; an 8-core CPU is required" }
        elseif ($cores -lt 8) { Add-Check 'Processor' 'WARNING' "$cores logical processors; 8 cores recommended" }
        else { Add-Check 'Processor' 'OK' "$cores logical processors" }
        $state.RamGb = [Math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
        if ($state.RamGb -lt 15) { Add-Check 'Memory' $short "$($state.RamGb) GB; 16 GB minimum, 32 GB recommended" }
        elseif ($state.RamGb -lt 30) { Add-Check 'Memory' 'WARNING' "$($state.RamGb) GB; 32 GB recommended" }
        else { Add-Check 'Memory' 'OK' "$($state.RamGb) GB" }

        $drive = (Get-IniValue $state.Ini 'Rig' 'DataDrive' 'D:').ToUpperInvariant()
        $disk = $null
        if ($drive -match '^[A-Z]:$') { $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$drive'" }
        if (-not $disk) { Add-Check 'Data drive' 'FAILED' "$drive not found: set [Rig] DataDrive to an existing drive (C: on a single-disk test PC)" }
        elseif ($disk.DriveType -ne 3) { Add-Check 'Data drive' 'FAILED' "$drive is not a local fixed disk" }
        else {
            $freeGb = [Math]::Round($disk.FreeSpace / 1GB)
            $existingDb = Test-Path -LiteralPath (Join-Parts "$drive\AHWR" 'data' 'pgdata' 'PG_VERSION')
            if ($freeGb -lt 20) { Add-Check "Data drive" 'FAILED' "$drive $freeGb GB free" }
            elseif (-not $existingDb -and $freeGb -lt 500) { Add-Check "Data drive" $short "$drive $freeGb GB free; at least 500 GB is needed for 90 days of raw PLC data" }
            else { Add-Check "Data drive" 'OK' "$drive $freeGb GB free" }
        }
        $sys = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($Root.Substring(0, 2))'"
        if ($sys -and $sys.FreeSpace -lt 10GB) { Add-Check 'Program drive' 'FAILED' "$($Root.Substring(0, 2)) $([Math]::Round($sys.FreeSpace / 1GB)) GB free; 10 GB needed" }

        try {
            $av = @(Get-CimInstance -Namespace 'root/SecurityCenter2' -ClassName AntiVirusProduct -ErrorAction Stop)
            if ($av.Count) { Add-Check 'Antivirus' 'OK' ((@($av | ForEach-Object { $_.displayName }) | Select-Object -Unique) -join ', ') }
            else { Add-Check 'Antivirus' 'WARNING' 'none registered with Windows Security' }
        } catch { Add-Check 'Antivirus' 'WARNING' 'could not be checked on this Windows edition' }

        $t = Get-TimeSyncState
        if (-not $t.Synced) { Add-Check 'Time' 'WARNING' "not synchronised (source: $($t.Source)); set the domain controller or NTP server" }
        elseif ($t.TimeZone -ne 'India Standard Time') { Add-Check 'Time' 'WARNING' "time zone is $($t.TimeZone); India Standard Time expected" }
        else { Add-Check 'Time' 'OK' "synchronised with $($t.Source), India Standard Time" }

        if (Test-Path -LiteralPath (Join-Path $Root 'settings.env')) {
            $state.Repair = $true
            Add-Check 'Existing installation' 'INFO' "found in ${Root}: repairing; the database, records and settings are kept"
        }

        # An older AHWR install elsewhere (services AHWR-Dashboard, AHWR-InfluxDB, AHWR-Telegraf).
        $mine = $Root.TrimEnd('\') + '\'
        $legacy = @(Get-CimInstance Win32_Service | Where-Object {
            $_.Name -in @('AHWR-Dashboard', 'AHWR-InfluxDB', 'AHWR-Telegraf') -and ([string]$_.PathName).IndexOf($mine, [StringComparison]::OrdinalIgnoreCase) -lt 0 })
        if ($legacy.Count) {
            Invoke-EdgeScript (Join-Path $AppSource 'Disable-Legacy-AHWR-Services.ps1') @('-CurrentRoot', $Root)
            Add-Check 'Older AHWR services' 'OK' ('stopped and set to Manual: ' + ((@($legacy | ForEach-Object { $_.Name })) -join ', '))
        }

        foreach ($port in $AhwrPorts.Keys) {
            $owner = Get-PortOwner $port
            if (-not $owner) { continue }
            if ($owner.Path -and $owner.Path.StartsWith($mine, [StringComparison]::OrdinalIgnoreCase)) { continue }
            $who = $owner.Name
            if ($owner.Path) { $who = $owner.Path }
            Add-Check "Port $port" 'FAILED' "in use by $who; $($AhwrPorts[$port]) needs it. Remove or move that software."
        }
        if (-not @(Get-CheckResults | Where-Object { $_.Check -like 'Port *' }).Count) { Add-Check 'Ports' 'OK' ((($AhwrPorts.Keys | ForEach-Object { [string]$_ }) -join ', ') + ' free') }

        Write-Host '      checking the installer files...' -ForegroundColor Gray
        $problems = @(Get-PackageChecksumProblems $PackageRoot)
        if ($problems.Count) { Add-Check 'Installer files' 'FAILED' ("$($problems.Count) file(s) damaged or changed (" + (($problems | Select-Object -First 3) -join '; ') + '). Copy the folder again from the released media.') }
        else { Add-Check 'Installer files' 'OK' 'all checksums match' }
    }

    # ------------------------------------------------------------------ 2
    Invoke-Stage 2 $Total 'Settings' {
        $drive = (Get-IniValue $state.Ini 'Rig' 'DataDrive' 'D:').ToUpperInvariant()
        $existing = Read-EnvFile (Join-Path $Root 'settings.env')
        if (-not $existing.Count) {
            $kept = Join-Parts "$drive\AHWR" 'kept-config' 'settings.env'
            if (Test-Path -LiteralPath $kept) { $existing = Read-EnvFile $kept; $state.KeptConfig = $kept }
        }
        $check = Test-RigSettings $state.Ini $existing
        foreach ($e in $check.Errors) { Add-Check 'rig-settings.ini' 'FAILED' $e }
        foreach ($w in $check.Warnings) { Add-Check 'rig-settings.ini' 'WARNING' $w }
        if ($check.Errors.Count) { return }
        $v = $check.Values
        $state.Values = $v
        if ($existing.Contains('DEVICE_ID') -and $existing['DEVICE_ID'] -and $existing['DEVICE_ID'] -notmatch 'CHANGE_ME' -and $existing['DEVICE_ID'] -ne $v.DeviceId) {
            Add-Check 'DeviceId' 'FAILED' "this PC is installed as rig '$($existing['DEVICE_ID'])'. DeviceId must never change: use '$($existing['DEVICE_ID'])', or remove the old data first (Uninstall.bat /purge)."
            return
        }
        $asset = ''
        if ($v.Asset) { $asset = " ($($v.Asset))" }
        Add-Check 'Values' 'OK' "rig $($v.DeviceId)$asset, data on $($v.DataDrive), HMI for $($v.RigLanSubnet -join ', ')"

        if (Test-TcpConnect $v.PlcAddress $v.PlcPort) { Add-Check 'PLC' 'OK' "$($v.PlcAddress) answers on TCP $($v.PlcPort) ($($v.PlcProtocol))" }
        else { Add-Check 'PLC' 'WARNING' "$($v.PlcAddress) does not answer on TCP $($v.PlcPort): check the cable, VLAN or firewall appliance (installation continues)" }
        if ($v.CentralUrl) {
            $u = Get-UriParts $v.CentralUrl 443
            if (Test-TcpConnect $u.Host $u.Port) { Add-Check 'CMF' 'OK' "$($u.Host) answers on TCP $($u.Port)" }
            else { Add-Check 'CMF' 'WARNING' "$($u.Host) does not answer on TCP $($u.Port) (installation continues; data waits in the upload buffer)" }
        }
        if ($v.EtpUrl) {
            $u = Get-UriParts $v.EtpUrl 443
            if (Test-TcpConnect $u.Host $u.Port) { Add-Check 'CMF ETP' 'OK' "$($u.Host) answers on TCP $($u.Port)" }
            else { Add-Check 'CMF ETP' 'WARNING' "$($u.Host) does not answer on TCP $($u.Port)" }
        }
        if ($v.DomainEnabled) {
            $u = Get-UriParts $v.DomainController 636
            if (Test-TcpConnect $u.Host $u.Port) { Add-Check 'Domain controller' 'OK' "$($u.Host) answers on TCP $($u.Port)" }
            else { Add-Check 'Domain controller' 'WARNING' "$($u.Host) does not answer on TCP $($u.Port); domain login will fail until it does" }
        }
        $ca = Join-Parts $PackageRoot 'certs' 'ongc-ca.crt'
        if (Test-Path -LiteralPath $ca) {
            try {
                $cert = New-Object Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList $ca
                if ($cert.NotAfter -lt (Get-Date)) { Add-Check 'CA certificate' 'FAILED' "certs\ongc-ca.crt expired on $($cert.NotAfter.ToString('yyyy-MM-dd'))" }
                else { Add-Check 'CA certificate' 'OK' "$($cert.Subject), valid until $($cert.NotAfter.ToString('yyyy-MM-dd'))" }
            } catch { Add-Check 'CA certificate' 'FAILED' "certs\ongc-ca.crt cannot be read: $($_.Exception.Message)" }
        } elseif ($v.CentralUrl -or $v.DomainEnabled) {
            Add-Check 'CA certificate' 'WARNING' 'certs\ongc-ca.crt not found: HTTPS to the CMF and LDAPS work only if their certificates are publicly trusted'
        }
    }

    # ------------------------------------------------------------------ 3
    Invoke-Stage 3 $Total 'Accounts and folders' {
        $v = $state.Values
        $dataRoot = "$($v.DataDrive)\AHWR"
        $state.DataRoot = $dataRoot
        foreach ($dir in @($Root, (Join-Path $Root 'config'), (Join-Path $Root 'certs'), (Join-Path $Root 'tools'), (Join-Path $Root 'run'), (Join-Path $Root 'runtime'))) {
            $null = New-Item -ItemType Directory -Force -Path $dir
        }
        Set-RestrictedAcl $Root @('S-1-5-19', 'S-1-5-20')
        Add-Check 'Program folder' 'OK' "$Root (Administrators and SYSTEM full control; service accounts read only)"
        if ($dataRoot -ine $Root) {
            $null = New-Item -ItemType Directory -Force -Path $dataRoot
            Set-RestrictedAcl $dataRoot @('S-1-5-19', 'S-1-5-20')
            New-DataJunction (Join-Path $Root 'data') (Join-Path $dataRoot 'data')
            # logs\ may already hold the older-services clean-up log from stage 1.
            New-DataJunction (Join-Path $Root 'logs') (Join-Path $dataRoot 'logs') -MoveExisting
            New-DataJunction (Join-Path $Root 'backups') (Join-Path $dataRoot 'backups') -MoveExisting
            Add-Check 'Data folders' 'OK' "$dataRoot\data (database, records, upload buffer), logs, backups"
        } else {
            foreach ($name in @('data', 'logs', 'backups')) { $null = New-Item -ItemType Directory -Force -Path (Join-Path $Root $name) }
            Add-Check 'Data folders' 'OK' "$Root\data, logs, backups (single drive)"
        }
        Set-SetupLog (Join-Parts $Root 'logs' 'install.log')
        Add-Check 'Service accounts' 'INFO' 'built-in LocalService (collector, backend) and NetworkService (database): no passwords to manage'

        $settingsPath = Join-Path $Root 'settings.env'
        if ($state.KeptConfig -and -not (Test-Path -LiteralPath $settingsPath)) {
            Copy-Item -LiteralPath $state.KeptConfig -Destination $settingsPath
            Add-Check 'Settings' 'INFO' "reused from the earlier installation ($($state.KeptConfig))"
        }
        $existing = Read-EnvFile $settingsPath
        if ((Test-Path -LiteralPath (Join-Parts $Root 'data' 'pgdata' 'PG_VERSION')) -and -not $existing.Contains('PG_SUPERUSER_PASSWORD')) {
            Add-Check 'Database' 'FAILED' "$dataRoot\data\pgdata belongs to an earlier installation whose settings.env is missing. Put that settings.env in $Root, or remove the old data with Uninstall.bat /purge."
            return
        }
        $caPem = ''
        $caSrc = Join-Parts $PackageRoot 'certs' 'ongc-ca.crt'
        if (Test-Path -LiteralPath $caSrc) {
            Copy-Item -LiteralPath $caSrc -Destination (Join-Parts $Root 'certs' 'ongc-ca.crt') -Force
            $caPem = Join-Parts $Root 'certs' 'ongc-ca.pem'
            $null = ConvertTo-PemCertificate $caSrc $caPem
        } elseif ($existing.Contains('NODE_EXTRA_CA_CERTS') -and $existing['NODE_EXTRA_CA_CERTS'] -and (Test-Path -LiteralPath $existing['NODE_EXTRA_CA_CERTS'])) {
            $caPem = $existing['NODE_EXTRA_CA_CERTS']
        }
        $updates = ConvertTo-EdgeSettings $v $existing $Root $caPem
        $state.Fresh = -not ($existing.Contains('JWT_SECRET') -and $existing['JWT_SECRET'])
        if ($existing.Contains('ADMIN_PASSWORD') -and $existing['ADMIN_PASSWORD']) {
            $state.AdminPassword = $existing['ADMIN_PASSWORD']   # an earlier run stopped before the first start
        } elseif ($state.Fresh) {
            $state.AdminPassword = New-Password
            $updates['ADMIN_USERNAME'] = 'admin'
            $updates['ADMIN_PASSWORD'] = $state.AdminPassword
        }
        Update-EnvFile $settingsPath $updates
        $state.Settings = Read-EnvFile $settingsPath
        if ($state.Fresh) { Add-Check 'Settings file' 'OK' "$settingsPath created; internal passwords generated" }
        else { Add-Check 'Settings file' 'OK' "$settingsPath updated from rig-settings.ini; passwords kept" }
        Copy-Item -LiteralPath $IniPath -Destination (Join-Parts $Root 'config' 'rig-settings.ini') -Force
    }

    # ------------------------------------------------------------------ 4
    Invoke-Stage 4 $Total 'Database' {
        $s = $state.Settings
        if ($state.Repair -and (Test-Path -LiteralPath (Join-Path $Root 'Stop-AHWR-EDGE.ps1'))) {
            # Release the programs before replacing them; everything restarts in stages 4 to 7.
            Invoke-EdgeScript (Join-Path $Root 'Stop-AHWR-EDGE.ps1') @('-All')
            Add-Check 'Running edge stopped' 'INFO' 'for the repair'
        }
        $pg = $Components['pgsql']; $ts = $Components['timescaledb']
        $marker = "$($pg.sha256)+$($ts.sha256)"
        $pgDir = Join-Parts $Root 'runtime' 'pgsql'
        $installed = Get-InstalledComponents $Root
        if (-not ($installed.ContainsKey('pgsql') -and $installed['pgsql'] -eq $marker -and (Test-Path -LiteralPath (Join-Parts $pgDir 'bin' 'postgres.exe')))) {
            Write-Host '      unpacking PostgreSQL and TimescaleDB...' -ForegroundColor Gray
            $tmp = "$pgDir.new"
            if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
            Expand-ZipTo (Join-Path $ComponentsDir $pg.file) $tmp $pg.strip @('pgAdmin 4/', 'StackBuilder/', 'doc/', 'include/')
            $tsTmp = Join-Path $Root 'run\timescaledb.new'
            if (Test-Path -LiteralPath $tsTmp) { Remove-Item -LiteralPath $tsTmp -Recurse -Force }
            Expand-ZipTo (Join-Path $ComponentsDir $ts.file) $tsTmp $ts.strip
            Copy-Item -Path (Join-Path $tsTmp '*.dll') -Destination (Join-Path $tmp 'lib') -Force
            Copy-Item -Path (Join-Path $tsTmp 'timescaledb.control') -Destination (Join-Parts $tmp 'share' 'extension') -Force
            Copy-Item -Path (Join-Path $tsTmp 'timescaledb--*.sql') -Destination (Join-Parts $tmp 'share' 'extension') -Force
            Remove-Item -LiteralPath $tsTmp -Recurse -Force
            if (Test-Path -LiteralPath $pgDir) { Remove-Item -LiteralPath $pgDir -Recurse -Force }
            Rename-Item -LiteralPath $tmp -NewName 'pgsql'
            Set-InstalledComponent $Root 'pgsql' $marker
            Add-Check 'PostgreSQL + TimescaleDB' 'OK' "PostgreSQL $($pg.version) with TimescaleDB $($ts.version) installed"
        } else { Add-Check 'PostgreSQL + TimescaleDB' 'OK' "PostgreSQL $($pg.version) with TimescaleDB $($ts.version) already installed" }

        $pgData = Join-Parts $Root 'data' 'pgdata'
        $bin = Join-Path $pgDir 'bin'
        if (-not (Test-Path -LiteralPath (Join-Path $pgData 'PG_VERSION'))) {
            $pwFile = Join-Parts $Root 'run' 'pg-init.tmp'
            [IO.File]::WriteAllText($pwFile, $s['PG_SUPERUSER_PASSWORD'], (New-Object Text.ASCIIEncoding))
            try { $r = Invoke-Native (Join-Path $bin 'initdb.exe') @('-D', $pgData, '-U', 'postgres', '-E', 'UTF8', '--locale=C', '--auth=scram-sha-256', "--pwfile=$pwFile") }
            finally { Remove-Item -LiteralPath $pwFile -Force -ErrorAction SilentlyContinue }
            if ($r.ExitCode -ne 0) { throw "initdb failed: $(($r.Output | Select-Object -Last 2) -join ' ')" }
            $ram = [double]$state.RamGb
            $sharedGb = [int][Math]::Max(1, [Math]::Min(8, [Math]::Floor($ram / 4)))
            $cacheGb = [int][Math]::Max(2, [Math]::Floor($ram / 2))
            $maintMb = [int][Math]::Max(256, [Math]::Min(2048, [Math]::Floor($ram * 1024 / 16)))
            Add-Content -LiteralPath (Join-Path $pgData 'postgresql.conf') -Encoding ASCII -Value @(
                '', '# AHWR-150 EDGE (TimescaleDB historian); memory sized for this PC by the installer',
                "listen_addresses = '127.0.0.1'", "port = $($s['PGPORT'])",
                "shared_preload_libraries = 'timescaledb'", 'timescaledb.telemetry_level = off',
                'timescaledb.max_background_workers = 8', 'max_worker_processes = 16',
                "shared_buffers = ${sharedGb}GB", "effective_cache_size = ${cacheGb}GB", "maintenance_work_mem = ${maintMb}MB",
                'max_wal_size = 4GB', 'checkpoint_timeout = 15min', 'wal_compression = on')
            Add-Check 'Database cluster' 'OK' "created in $($state.DataRoot)\data\pgdata, this PC only; shared_buffers $sharedGb GB, effective_cache_size $cacheGb GB (RAM $ram GB)"
        } else { Add-Check 'Database cluster' 'OK' 'existing cluster kept' }

        $pgCtl = Join-Path $bin 'pg_ctl.exe'
        if (Get-Service -Name 'AHWR-PostgreSQL' -ErrorAction SilentlyContinue) { Start-AhwrServices @('AHWR-PostgreSQL') }
        elseif ((Invoke-Native $pgCtl @('status', '-D', $pgData)).ExitCode -ne 0) {
            $r = Invoke-Native $pgCtl @('start', '-D', $pgData, '-l', (Join-Parts $Root 'logs' 'postgresql-install.log'), '-w', '-t', '120')
            if ($r.ExitCode -ne 0) { throw 'PostgreSQL did not start; see logs\postgresql-install.log' }
        }
        $psql = Join-Path $bin 'psql.exe'
        $sqlDir = Join-Parts $AppSource 'app' 'sql'
        $env:PGPASSWORD = $s['PG_SUPERUSER_PASSWORD']
        try {
            $r = Invoke-Native $psql @('-X', '-q', '-h', '127.0.0.1', '-p', $s['PGPORT'], '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
                '-v', "tg_pw=$($s['TELEGRAF_DB_PASSWORD'])", '-v', "app_pw=$($s['PGPASSWORD'])", '-f', (Join-Path $sqlDir '01-roles.sql'))
            if ($r.ExitCode -ne 0) { throw "01-roles.sql failed: $(($r.Output | Select-Object -Last 2) -join ' ')" }
            $r = Invoke-Native $psql @('-X', '-q', '-h', '127.0.0.1', '-p', $s['PGPORT'], '-U', 'postgres', '-d', $s['PGDATABASE'], '-v', 'ON_ERROR_STOP=1', '-f', (Join-Path $sqlDir '02-schema.sql'))
            if ($r.ExitCode -ne 0) { throw "02-schema.sql failed: $(($r.Output | Select-Object -Last 2) -join ' ')" }
        } finally { $env:PGPASSWORD = $null }
        $ver = Invoke-EdgeSql $Root $s "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'"
        Add-Check 'Database and accounts' 'OK' "ahwr_edge with TimescaleDB $ver; accounts ahwr_app and telegraf_writer (insert only)"
    }

    # ------------------------------------------------------------------ 5
    Invoke-Stage 5 $Total 'Data collector' {
        $target = Join-Parts $Root 'runtime' 'telegraf'
        $changed = Install-ZipComponent 'telegraf' $target
        $r = Invoke-Native (Join-Path $target 'telegraf.exe') @('--version')
        if ($r.ExitCode -ne 0) { throw 'telegraf.exe does not run' }
        $what = 'already installed'
        if ($changed) { $what = 'installed' }
        Add-Check 'Telegraf' 'OK' "$(($r.Output -join ' ').Trim()) $what; writes to the database with an insert-only account"
        Add-Check 'Retention' 'INFO' 'raw PLC data compressed after 12 hours and kept 90 days; 1-minute data per well kept indefinitely'
    }

    # ------------------------------------------------------------------ 6
    Invoke-Stage 6 $Total 'Application' {
        $v = $state.Values
        $nodeDir = Join-Parts $Root 'runtime' 'node'
        $null = Install-ZipComponent 'node' $nodeDir
        $r = Invoke-Native (Join-Path $nodeDir 'node.exe') @('--version')
        Add-Check 'Node.js' 'OK' (($r.Output -join ' ').Trim())

        $py = $Components['python']; $wheels = $Components['python-wheels']
        $pyDir = Join-Parts $Root 'runtime' 'python'
        $marker = "$($py.sha256)+$($wheels.sha256)"
        $installed = Get-InstalledComponents $Root
        if (-not ($installed.ContainsKey('python') -and $installed['python'] -eq $marker -and (Test-Path -LiteralPath (Join-Path $pyDir 'python.exe')))) {
            $tmp = "$pyDir.new"
            if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
            Install-PythonEmbedded (Join-Path $ComponentsDir $py.file) (Join-Path $ComponentsDir $wheels.dir) $tmp
            if (Test-Path -LiteralPath $pyDir) { Remove-Item -LiteralPath $pyDir -Recurse -Force }
            Rename-Item -LiteralPath $tmp -NewName 'python'
            Set-InstalledComponent $Root 'python' $marker
        }
        $r = Invoke-Native (Join-Path $pyDir 'python.exe') @('-c', "import asyncua, importlib.metadata as m, sys; print('Python', sys.version.split()[0], '+ asyncua', m.version('asyncua'))")
        if ($r.ExitCode -ne 0) { throw "the BOP collector runtime does not start: $(($r.Output | Select-Object -Last 1) -join ' ')" }
        Add-Check 'Python (BOP collector)' 'OK' (($r.Output -join ' ').Trim())

        $null = Install-ZipComponent 'nssm' (Join-Parts $Root 'runtime' 'nssm') @('nssm.exe')
        Add-Check 'Service wrapper' 'OK' "NSSM $($Components['nssm'].version)"

        $exclude = @('data', 'logs', 'backups', 'run', 'runtime', 'config', 'certs', 'tools') | ForEach-Object { Join-Path $AppSource $_ }
        $r = Invoke-Native 'robocopy.exe' (@($AppSource, $Root, '/E', '/R:2', '/W:2', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/XF', 'settings.env', '/XD') + $exclude)
        if ($r.ExitCode -ge 8) { throw "copying the application failed (robocopy $($r.ExitCode))" }
        Add-Check 'Edge application' 'OK' "copied to $Root"

        $seed = Join-Parts $Root 'data' 'app' 'plc_config.json'
        if ($state.Fresh -and $v.PlcProtocol -eq 'S7' -and -not (Test-Path -LiteralPath $seed)) {
            $cfg = Get-Content -LiteralPath (Join-Parts $Root 'app' 'backend' 'defaults' 'plc_config.json') -Raw | ConvertFrom-Json
            foreach ($slave in @($cfg.slaves)) { if ($slave.protocol -eq 's7comm') { $slave.ip = $v.PlcAddress } }
            $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $seed)
            Write-Utf8File $seed @(($cfg | ConvertTo-Json -Depth 32))
            Add-Check 'PLC connection' 'OK' "S7 PLC $($v.PlcAddress) with the standard AHWR tag map; check it under Settings > PLC config"
        } elseif ($state.Fresh -and $v.PlcProtocol -eq 'Modbus') {
            Add-Check 'PLC connection' 'INFO' 'add the Modbus TCP device and its register map under Settings > PLC config'
        }

        # Firewall rule before the first start, so Windows does not ask to open the HMI to every network.
        $null = Set-HmiFirewall $v.RigLanSubnet (Join-Path $nodeDir 'node.exe')
        Write-Host '      first start (database schema, admin account, web UI)...' -ForegroundColor Gray
        Invoke-EdgeScript (Join-Path $Root 'Start-AHWR-EDGE.ps1') @() @{ AHWR_NO_BROWSER = '1' }
        Add-Check 'First start' 'OK' 'schema applied, web UI answered'
    }

    # ------------------------------------------------------------------ 7
    Invoke-Stage 7 $Total 'Services' {
        $mine = $Root.TrimEnd('\') + '\'
        $old = Get-CimInstance Win32_Service -Filter "Name='AHWR-Telegraf'" -ErrorAction SilentlyContinue
        if ($old -and ([string]$old.PathName).IndexOf($mine, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
            Stop-AhwrServices @('AHWR-Telegraf')
            $null = Invoke-Native 'sc.exe' @('delete', 'AHWR-Telegraf')
            Add-Check 'Older AHWR-Telegraf service' 'INFO' "removed ($($old.PathName))"
        }
        Invoke-EdgeScript (Join-Path $Root 'Install-AHWR-EDGE-Services.ps1') @('-NssmPath', (Join-Parts $Root 'runtime' 'nssm' 'nssm.exe'), '-BackupTime', '02:30')
        Start-AhwrServices $AhwrServices
        foreach ($name in $AhwrServices) { Add-Check $name 'OK' 'registered: starts with Windows, restarts after a failure' }
        if (-not (Wait-HttpOk 'http://127.0.0.1:8080/healthz' 90)) { throw 'the web UI does not answer after the services started; see logs\AHWR-Backend.log' }
    }

    # ------------------------------------------------------------------ 8
    Invoke-Stage 8 $Total 'Firewall and power' {
        $v = $state.Values
        $removed = Set-HmiFirewall $v.RigLanSubnet (Join-Parts $Root 'runtime' 'node' 'node.exe')
        Add-Check 'Firewall' 'OK' "port 8080 open to $($v.RigLanSubnet -join ', ') only; 5432, 8888 and 8186 closed to the network"
        if ($removed) { Add-Check 'Firewall' 'INFO' "$removed other inbound rule(s) for the edge's node.exe removed" }
        foreach ($p in @(Get-NetFirewallProfile -PolicyStore ActiveStore -ErrorAction SilentlyContinue)) {
            if ([string]$p.Enabled -eq 'False') { Add-Check 'Firewall' 'WARNING' "Windows Firewall is off for the $($p.Name) profile" }
            if ([string]$p.AllowLocalFirewallRules -eq 'False') { Add-Check 'Firewall' 'WARNING' "a group policy ignores local rules on the $($p.Name) profile: ask IT to allow TCP 8080 from the rig LAN" }
        }
        Set-EdgePowerPlan
        Add-Check 'Power' 'OK' 'high performance plan; sleep and hibernation off'
    }

    # ------------------------------------------------------------------ 9
    Invoke-Stage 9 $Total 'Scheduled tasks' {
        if (Get-ScheduledTask -TaskName 'AHWR-EDGE records backup' -ErrorAction SilentlyContinue) { Add-Check 'Records backup' 'OK' 'daily at 02:30 to backups\, 14 days kept' }
        else { Add-Check 'Records backup' 'FAILED' 'scheduled task missing' }
        $cleanup = 'Get-ChildItem -LiteralPath ''{0}'' -Recurse -File | Where-Object {{ $_.LastWriteTime -lt (Get-Date).AddDays(-30) }} | Remove-Item -Force -ErrorAction SilentlyContinue' -f (Join-Path $Root 'logs')
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -Command "' + $cleanup + '"')
        $trigger = New-ScheduledTaskTrigger -Daily -At '03:15'
        $null = Register-ScheduledTask -TaskName 'AHWR-EDGE log cleanup' -Action $action -Trigger $trigger -User 'SYSTEM' -RunLevel Highest -Force
        Add-Check 'Log clean-up' 'OK' 'daily at 03:15, logs older than 30 days'

        $tools = Join-Path $Root 'tools'
        foreach ($bat in @('Apply-Settings.bat', 'Check-Health.bat', 'Backup-Now.bat', 'Restore-Records.bat', 'Collect-Logs.bat', 'Uninstall.bat')) {
            Copy-Item -LiteralPath (Join-Path $PackageRoot $bat) -Destination $tools -Force
        }
        $toolSetup = Join-Path $tools 'setup'
        $null = New-Item -ItemType Directory -Force -Path $toolSetup
        Copy-Item -Path (Join-Path $SetupDir '*') -Destination $toolSetup -Force
        Copy-Item -LiteralPath (Join-Path $PackageRoot 'VERSION.txt') -Destination $tools -Force
        $info = [ordered]@{ version = $Version; deviceId = $state.Values.DeviceId; dataRoot = $state.DataRoot; installedAt = (Get-Date).ToString('o'); package = $PackageRoot }
        $old = Read-InstallInfo $Root
        if ($old) { $info.installedAt = $old.installedAt; $info['repairedAt'] = (Get-Date).ToString('o') }
        Write-Utf8File (Join-Parts $Root 'config' 'install.json') @(($info | ConvertTo-Json))
        Add-Check 'Tools' 'OK' "$tools (Apply-Settings, Check-Health, Backup-Now, Restore-Records, Collect-Logs, Uninstall)"
    }

    # ------------------------------------------------------------------ 10
    Invoke-Stage 10 $Total 'Self-test' {
        Invoke-SelfTest $Root
        $cleared = @(@(Clear-IniSecrets (Join-Parts $Root 'config' 'rig-settings.ini')) + @(Clear-IniSecrets $IniPath) | Select-Object -Unique)
        if ($cleared.Count) { Add-Check 'Secrets' 'INFO' ("moved into the protected settings and blanked in rig-settings.ini: " + ($cleared -join ', ')) }
    }

    $outcome = 'INSTALLATION SUCCESSFUL'
    $exitCode = 0
} catch {
    Write-Host ''
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host 'Fix what is named above and run Install.bat again; a second run repairs and continues.' -ForegroundColor Yellow
} finally {
    $credentials = $null
    if ($exitCode -eq 0 -and $state.AdminPassword) {
        $credentials = Join-Path ((Get-DesktopPath)) "AHWR-credentials-$($state.Values.DeviceId).txt"
        Write-Utf8File $credentials @(
            "AHWR-150 EDGE $($state.Values.DeviceId) - created $(Get-Date -Format 'yyyy-MM-dd HH:mm')",
            'Move these into the asset password safe, then delete this file.', '',
            "Web UI:              http://$(Get-LanAddress):8080",
            'Web admin user:      admin',
            "Web admin password:  $($state.AdminPassword)   (change it at the first sign-in)",
            "Database superuser:  postgres / $($state.Settings['PG_SUPERUSER_PASSWORD'])",
            'All other internal passwords are in C:\AHWR\settings.env (administrators only).')
        & icacls.exe $credentials /inheritance:r /grant:r "*$(Get-CurrentUserSid):F" /C /Q | Out-Null
    }
    $facts = [ordered]@{ 'Installer version' = $Version; 'Computer' = $env:COMPUTERNAME }
    if ($state.Values) { $facts['Rig (DeviceId)'] = $state.Values.DeviceId }
    $facts['Programs'] = $Root
    if ($state.DataRoot) { $facts['Data, logs, backups'] = $state.DataRoot }
    if ($exitCode -eq 0) { $facts['Web UI'] = "http://$(Get-LanAddress):8080" }
    foreach ($name in @('pgsql', 'timescaledb', 'telegraf', 'node', 'python', 'nssm')) { if ($Components[$name]) { $facts["Component $name"] = $Components[$name].version } }
    if ($credentials) { $facts['Credentials file'] = $credentials }
    $reportDir = Join-Path $Root 'logs'
    if (-not (Test-Path -LiteralPath $reportDir)) { $reportDir = $env:TEMP }
    $report = Join-Path $reportDir 'install-report.html'
    try { Write-SetupReport $report "AHWR-150 EDGE installation" $outcome $facts } catch { Write-Host "Report not written: $($_.Exception.Message)" -ForegroundColor Yellow }
    Write-Host ''
    if ($exitCode -eq 0) {
        Write-Host '=====================================' -ForegroundColor Green
        Write-Host ' INSTALLATION SUCCESSFUL' -ForegroundColor Green
        Write-Host '=====================================' -ForegroundColor Green
        if ($credentials) { Write-Host "Credentials: $credentials  (move to the password safe, then delete)" -ForegroundColor Yellow }
        Write-Host 'Next: sign in, map the PLC tags, confirm the CMF link (guide, section 6).'
    } else {
        Write-Host ' INSTALLATION FAILED' -ForegroundColor Red
    }
    Write-Host "Report: $report"
    if (Test-Path -LiteralPath $report) { Start-Process $report }
    if ($PauseAtEnd) { $null = Read-Host 'Press Enter to close this window' }
}
exit $exitCode
