# Dry run of the installer and its tools on a non-Windows machine (pwsh 7):
# the real scripts run against a built package, with Windows-only commands
# (services, firewall, ACLs, junctions, scheduled tasks, PostgreSQL/Telegraf/Node
# executables) simulated. Everything else is real: checksums, unpacking the
# bundled components, settings, folders, tools, reports.
#   pwsh -NoProfile -File installer/test/dryrun.ps1 <built package folder>
param([Parameter(Mandatory = $true)][string]$Package, [string]$Step = '', [switch]$PackageSetup)
$ErrorActionPreference = 'Stop'
$Package = (Resolve-Path $Package).Path

if ($Step) {
    # ---- child process: global mocks, then one real script --------------------------------------
    $global:State = Get-Content -LiteralPath $env:DRY_STATE -Raw | ConvertFrom-Json -AsHashtable
    function global:Save-DryState { $global:State | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $env:DRY_STATE }
    function global:New-MockService([string]$Name) { [pscustomobject]@{ Name = $Name } }
    function global:Get-CimInstance {
        param([Parameter(Position = 0)][string]$ClassName, [string]$Filter, [string]$Namespace)
        switch ($ClassName) {
            'Win32_OperatingSystem' { [pscustomobject]@{ Caption = 'Microsoft Windows 11 IoT Enterprise LTSC'; BuildNumber = '26100'; LastBootUpTime = (Get-Date) } }
            'Win32_ComputerSystem' { [pscustomobject]@{ TotalPhysicalMemory = 32GB } }
            'Win32_LogicalDisk' { [pscustomobject]@{ DeviceID = 'D:'; DriveType = 3; FreeSpace = 800GB; Size = 900GB } }
            'Win32_Service' {
                foreach ($k in @($global:State.services.Keys)) {
                    $s = $global:State.services[$k]
                    if (-not $Filter -or $Filter -match "Name='$k'") { [pscustomobject]@{ Name = $k; State = $s.State; StartMode = 'Auto'; PathName = $s.Path } }
                }
            }
            'AntiVirusProduct' { [pscustomobject]@{ displayName = 'Microsoft Defender Antivirus' } }
        }
    }
    function global:Get-Service { param([Parameter(Position = 0)][string]$Name)
        if (-not $global:State.services.ContainsKey($Name)) { return $null }
        $o = [pscustomobject]@{ Name = $Name; Status = $global:State.services[$Name].State }
        $o | Add-Member ScriptMethod WaitForStatus { param($s, $t) } -PassThru
    }
    function global:Start-Service { param([string]$Name, [object]$ErrorAction) if ($global:State.services.ContainsKey($Name)) { $global:State.services[$Name].State = 'Running'; Save-DryState } }
    function global:Stop-Service { param([string]$Name, [switch]$Force, [object]$ErrorAction) if ($global:State.services.ContainsKey($Name)) { $global:State.services[$Name].State = 'Stopped'; Save-DryState } }
    function global:Get-NetTCPConnection { }
    function global:Get-NetIPAddress { [pscustomobject]@{ IPAddress = '10.20.30.5'; AddressState = 'Preferred' } }
    function global:New-NetFirewallRule { param([string]$DisplayName, [string]$Group, $Direction, $Action, $Protocol, $LocalPort, $RemoteAddress, $Program, $Profile)
        $global:State.rules += @(@{ Name = [guid]::NewGuid().ToString(); DisplayName = $DisplayName; Group = $Group; Action = [string]$Action; Enabled = 'True'; Remote = (@($RemoteAddress) -join ',') }); Save-DryState }
    function global:Get-NetFirewallRule { param([string]$Group, [object]$ErrorAction) foreach ($r in @($global:State.rules)) { if ($r.Group -eq $Group) { [pscustomobject]$r } } }
    function global:Remove-NetFirewallRule { param([Parameter(ValueFromPipeline = $true)]$InputObject, [string]$Name)
        process { $n = $Name; if ($InputObject) { $n = $InputObject.Name }; $global:State.rules = @($global:State.rules | Where-Object { $_.Name -ne $n }); Save-DryState } }
    function global:Get-NetFirewallApplicationFilter { $null }
    function global:Get-NetFirewallProfile { @([pscustomobject]@{ Name = 'Domain'; Enabled = 'True'; AllowLocalFirewallRules = 'NotConfigured' }) }
    function global:New-ScheduledTaskAction { [pscustomobject]@{ Args = $args } }
    function global:New-ScheduledTaskTrigger { [pscustomobject]@{ Args = $args } }
    function global:Register-ScheduledTask { param([string]$TaskName) $global:State.tasks += @($TaskName); Save-DryState; [pscustomobject]@{ TaskName = $TaskName } }
    function global:Get-ScheduledTask { param([string]$TaskName, [object]$ErrorAction) if ($global:State.tasks -contains $TaskName) { [pscustomobject]@{ TaskName = $TaskName } } }
    function global:Unregister-ScheduledTask { param([string]$TaskName) $global:State.tasks = @($global:State.tasks | Where-Object { $_ -ne $TaskName }); Save-DryState }
    function global:Start-Process { $global:State.opened += @([string]$args[0]); Save-DryState }
    function global:Read-Host { param([Parameter(Position = 0)][string]$Prompt) $a = @($global:State.answers); $global:State.answers = @($a | Select-Object -Skip 1); Save-DryState; Write-Host "$Prompt> $($a[0])"; return $a[0] }
    foreach ($exe in @('icacls.exe', 'cmd.exe', 'powercfg.exe', 'w32tm.exe')) { Set-Item -Path "function:global:$exe" -Value { $global:LASTEXITCODE = 0 } }
    $null = New-PSDrive -Name D -PSProvider FileSystem -Root $env:DRY_DDRIVE -Scope Global   # the data drive
    $script = Join-Path $env:DRY_PACKAGE "setup/$Step.ps1"
    $params = @{}
    if ($env:DRY_ARG) { $params['Option'] = $env:DRY_ARG }
    & $script @params
    exit $LASTEXITCODE
}

# ---- parent: build a test package view, run the steps, check the results -------------------------
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('ahwr-dryrun-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$pkg = Join-Path $tmp 'AHWR-Edge-Setup'
$null = New-Item -ItemType Directory -Force -Path (Join-Path $pkg 'setup'), (Join-Path $pkg 'certs'), (Join-Path $tmp 'home/Desktop'), (Join-Path $tmp 'cwd')
foreach ($d in @('app', 'components')) { $null = New-Item -ItemType SymbolicLink -Path (Join-Path $pkg $d) -Target (Join-Path $Package $d) }
Get-ChildItem -LiteralPath $Package -File | Copy-Item -Destination $pkg
$setupSource = Join-Path (Split-Path -Parent $PSScriptRoot) 'setup'   # the scripts being worked on
if ($PackageSetup) { $setupSource = Join-Path $Package 'setup' }   # the scripts as shipped
Copy-Item (Join-Path $setupSource '*') (Join-Path $pkg 'setup')
$root = Join-Path $tmp 'AHWR'
$dataRoot = Join-Path $tmp 'ddrive/AHWR'   # D:\AHWR, through the D: drive mapped in the child
$null = New-Item -ItemType Directory -Force -Path (Join-Path $tmp 'ddrive')

# Module-level simulations, appended to the test copy of the module (the last definition wins).
$mocks = @'

# ---------------- dry-run simulations ----------------
$script:RealChecksums = ${function:Get-PackageChecksumProblems}
function Get-PackageChecksumProblems([string]$PackageRoot) { @(& $script:RealChecksums $PackageRoot | Where-Object { $_ -notmatch 'setup/' }) }
function Test-IsAdministrator { $true }
function Get-CurrentUserName { 'EDGE01\installer' }
function Get-DesktopPath { Join-Path $env:DRY_HOME 'Desktop' }
function Get-CurrentUserSid { 'S-1-5-21-1-2-3-1001' }
function Restart-Elevated { throw 'dry run: elevation requested' }
function Set-RestrictedAcl([string]$Path, [string[]]$ReadSids = @()) { Write-Log "acl $Path" }
function New-DataJunction([string]$Link, [string]$Target, [switch]$MoveExisting) {
    if (-not (Test-Path -LiteralPath $Target)) { $null = New-Item -ItemType Directory -Force -Path $Target }
    $Target = (Get-Item -LiteralPath $Target).FullName
    if (Test-Path -LiteralPath $Link) {
        if ((Get-Item -LiteralPath $Link -Force).LinkType) { return }
        foreach ($c in @(Get-ChildItem -LiteralPath $Link -Force)) { if (-not $MoveExisting) { throw "$Link already holds files" }; Move-Item $c.FullName $Target -Force }
        Remove-Item -LiteralPath $Link -Force -Recurse
    }
    $null = New-Item -ItemType SymbolicLink -Path $Link -Target $Target
}
function Remove-DataJunction([string]$Link) { $i = Get-Item -LiteralPath $Link -Force -ErrorAction SilentlyContinue; if ($i -and $i.LinkType) { $i.Delete() } }
function Test-TcpConnect { $true }
function Get-PortOwner { $null }
function Get-TimeSyncState { [pscustomobject]@{ Synced = $true; Source = 'dc01.ongc.local'; TimeZone = 'India Standard Time' } }
function Set-EdgePowerPlan { }
function Wait-HttpOk { return [bool]$global:State.httpOk }
function Invoke-EdgeSql([string]$Root, $Settings, [string]$Sql, [switch]$AsSuperuser, [string]$Database = '') {
    if ($Sql -match 'server_version') { return '18.6 + TimescaleDB 2.30.2' }
    if ($Sql -match 'extversion') { return '2.30.2' }
    if ($Sql -match 'FROM telemetry') { return '31140|519' }
    return ''
}
function Invoke-Native([string]$FilePath, [string[]]$Arguments = @()) {
    $leaf = Split-Path -Leaf $FilePath
    Write-Log ("native $leaf " + ($Arguments -join ' '))
    $out = @(); $code = 0
    switch -Regex ($leaf) {
        'initdb' { $d = $Arguments[[array]::IndexOf($Arguments, '-D') + 1]; $null = New-Item -ItemType Directory -Force -Path $d; Set-Content (Join-Path $d 'PG_VERSION') '18'; Set-Content (Join-Path $d 'postgresql.conf') '# initdb' }
        'pg_ctl' { if ($Arguments[0] -eq 'status') { $code = 3 } }
        'telegraf' { $out = @('Telegraf 1.36.4 (git: HEAD@1)') }
        'node' { $out = @('v22.23.3') }
        'python' { $out = @('Python 3.12.10 + asyncua 1.1.5') }
        'postgres' { $out = @('postgres (PostgreSQL) 18.6') }
        'robocopy' {
            $src = $Arguments[0]; $dst = $Arguments[1]; $xd = @(); $i = [array]::IndexOf($Arguments, '/XD')
            if ($i -ge 0) { $xd = @($Arguments | Select-Object -Skip ($i + 1)) }
            foreach ($item in @(Get-ChildItem -LiteralPath $src -Force)) {
                if ($xd -contains $item.FullName -or $item.Name -eq 'settings.env') { continue }
                Copy-Item -LiteralPath $item.FullName -Destination $dst -Recurse -Force
            }
            $code = 1
        }
    }
    return [pscustomobject]@{ ExitCode = $code; Output = $out }
}
function Invoke-EdgeScript([string]$ScriptPath, [string[]]$Arguments = @(), [hashtable]$Environment = @{}) {
    $leaf = Split-Path -Leaf $ScriptPath
    Write-Log ("script $leaf " + ($Arguments -join ' '))
    if (-not (Test-Path -LiteralPath $ScriptPath)) { throw "dry run: $ScriptPath missing" }
    $root = Get-AhwrInstallRoot
    $settings = Join-Path $root 'settings.env'
    switch ($leaf) {
        'Start-AHWR-EDGE.ps1' {
            if ($Environment['AHWR_NO_BROWSER'] -ne '1') { throw 'dry run: browser would open' }
            if (-not $global:State.startOk) { throw 'Start-AHWR-EDGE.ps1 failed (exit 1): AHWR backend did not answer' }
            $lines = @(Get-Content -LiteralPath $settings | Where-Object { $_ -notmatch '^ADMIN_PASSWORD=' })
            Set-Content -LiteralPath $settings -Value $lines
            foreach ($k in @($global:State.services.Keys)) { $global:State.services[$k].State = 'Running' }; Save-DryState
        }
        'Install-AHWR-EDGE-Services.ps1' {
            if ((Get-Content -LiteralPath $settings -Raw) -match '(?m)^ADMIN_PASSWORD=') { throw 'dry run: services installed before the first start' }
            foreach ($n in $AhwrServices) { $global:State.services[$n] = @{ State = 'Running'; Path = (Join-Path $root 'runtime\nssm\nssm.exe') } }
            if ($global:State.tasks -notcontains 'AHWR-EDGE records backup') { $global:State.tasks += @('AHWR-EDGE records backup') }
            Save-DryState
        }
        'Remove-AHWR-EDGE-Services.ps1' { $global:State.services = @{}; $global:State.tasks = @($global:State.tasks | Where-Object { $_ -ne 'AHWR-EDGE records backup' }); Save-DryState }
        'Stop-AHWR-EDGE.ps1' { foreach ($k in @($global:State.services.Keys)) { $global:State.services[$k].State = 'Stopped' }; Save-DryState }
        'Backup-AHWR-EDGE-Records.ps1' { $b = Join-Path $root 'backups'; $null = New-Item -ItemType Directory -Force -Path $b; Set-Content (Join-Path $b ('records-{0:yyyyMMdd-HHmmss}.dump' -f (Get-Date))) 'dump' }
    }
}
'@
Add-Content -LiteralPath (Join-Path $pkg 'setup/AhwrSetup.psm1') -Value $mocks

$ini = Join-Path $pkg 'rig-settings.ini'
$filled = (Get-Content $ini -Raw).Replace('<rig name>', 'AHWR-50-III').Replace('<asset, e.g. Ankleshwar>', 'Ankleshwar').
    Replace('<rig LAN subnet, e.g. 10.20.30.0/24>', '10.20.30.0/24').Replace('<PLC IP address, e.g. 192.168.0.11>', '192.168.7.21').
    Replace('DeviceToken =', 'DeviceToken = tok-AHWR50III-0123456789')
Set-Content -LiteralPath $ini -Value $filled -NoNewline

$stateFile = Join-Path $tmp 'state.json'
@{ services = @{}; rules = @(); tasks = @(); opened = @(); answers = @(); httpOk = $true; startOk = $true } | ConvertTo-Json -Depth 6 | Set-Content $stateFile
$script:fail = 0; $script:pass = 0
function Check([bool]$c, [string]$what) { if ($c) { $script:pass++; Write-Host "  ok   $what" -ForegroundColor Green } else { $script:fail++; Write-Host "  FAIL $what" -ForegroundColor Red } }
function Get-DryState { Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json -AsHashtable }
function Set-DryState([scriptblock]$Change) { $s = Get-DryState; & $Change $s; $s | ConvertTo-Json -Depth 6 | Set-Content $stateFile }
function Run([string]$Step, [string]$Arg = '') {
    Write-Host "`n===== $Step $Arg" -ForegroundColor Cyan
    $env:DRY_STATE = $stateFile; $env:DRY_PACKAGE = $pkg; $env:DRY_ARG = $Arg; $env:AHWR_INSTALL_ROOT = $root; $env:DRY_HOME = (Join-Path $tmp 'home'); $env:TEMP = (Join-Path $tmp 'cwd'); $env:DRY_DDRIVE = (Join-Path $tmp 'ddrive')
    Push-Location (Join-Path $tmp 'cwd')
    try { & pwsh -NoProfile -File $PSCommandPath -Package $Package -Step $Step 2>&1 | ForEach-Object { "    $_" } | Out-Host; $code = $LASTEXITCODE } finally { Pop-Location }
    return $code
}
function Get-Settings { $h = @{}; foreach ($l in Get-Content (Join-Path $root 'settings.env')) { if ($l -match '^([^#=]+)=(.*)$') { $h[$matches[1].Trim()] = $matches[2] } }; $h }

# 1. Fresh install
$code = Run 'Install'
Check ($code -eq 0) 'install exits 0'
$report = Get-Content (Join-Path $root 'logs/install-report.html') -Raw
Check ($report -match 'INSTALLATION SUCCESSFUL') 'report says INSTALLATION SUCCESSFUL'
$s = Get-Settings
Check ($s['DEVICE_ID'] -eq 'AHWR-50-III' -and $s['DEVICE_TOKEN'] -eq 'tok-AHWR50III-0123456789' -and $s['SYNC_ENABLED'] -eq 'true') 'settings: rig, token, sync on'
Check (-not $s.ContainsKey('ADMIN_PASSWORD') -and $s['JWT_SECRET'] -match '^[0-9a-f]{64}$' -and $s['PG_MODE'] -eq 'bundled') 'settings: admin password gone after the first start, secrets generated'
foreach ($f in @('runtime/pgsql/bin/postgres.exe', 'runtime/pgsql/lib/timescaledb-2.30.2.dll', 'runtime/pgsql/share/extension/timescaledb.control', 'runtime/telegraf/telegraf.exe',
        'runtime/node/node.exe', 'runtime/python/python.exe', 'runtime/python/Lib/site-packages/asyncua/__init__.py', 'runtime/nssm/nssm.exe',
        'app/backend/server.js', 'Start-AHWR-EDGE.ps1', 'tools/Check-Health.bat', 'tools/setup/AhwrSetup.psm1', 'config/rig-settings.ini', 'config/install.json')) {
    Check (Test-Path (Join-Path $root $f)) "installed $f"
}
Check (-not (Test-Path (Join-Path $root 'runtime/pgsql/pgAdmin 4'))) 'pgAdmin not installed'
Check ((Get-Content (Join-Path $root 'data/pgdata/postgresql.conf') -Raw) -match "shared_buffers = 8GB" ) 'database sized for 32 GB RAM'
Check ((Get-Item (Join-Path $root 'data')).LinkType -and (Test-Path (Join-Path $dataRoot 'data/pgdata/PG_VERSION'))) 'data linked to the data drive'
$plc = Get-Content (Join-Path $root 'data/app/plc_config.json') -Raw | ConvertFrom-Json
Check ((@($plc.slaves | Where-Object { $_.protocol -eq 's7comm' })[0].ip) -eq '192.168.7.21') 'PLC address written into the standard tag map'
$cred = Join-Path $tmp 'home/Desktop/AHWR-credentials-AHWR-50-III.txt'
Check ((Test-Path $cred) -and (Get-Content $cred -Raw) -match 'Web admin password:\s+\S{20}') 'credentials file on the desktop'
Check (-not (Select-String -Path (Join-Path $root 'config/rig-settings.ini'), $ini -Pattern 'tok-AHWR50III' -Quiet)) 'token blanked in both rig-settings.ini copies'
$st = Get-DryState
Check (@($st.services.Keys).Count -eq 4 -and @($st.rules).Count -eq 2 -and $st.tasks -contains 'AHWR-EDGE log cleanup' -and $st.tasks -contains 'AHWR-EDGE records backup') 'services, firewall rules, tasks'
Check (@($st.rules | Where-Object { $_.Remote -eq '10.20.30.0/24' }).Count -eq 1) 'HMI rule limited to the rig LAN'
$firstJwt = $s['JWT_SECRET']

# 2. Repair: run again
Remove-Item $cred
$code = Run 'Install'
$s = Get-Settings
Check ($code -eq 0 -and $s['JWT_SECRET'] -eq $firstJwt -and $s['DEVICE_TOKEN'] -eq 'tok-AHWR50III-0123456789') 'repair keeps the secrets and the stored token'
Check (-not (Test-Path $cred)) 'no new credentials file on a repair'
Check ((Get-Content (Join-Path $root 'logs/install.log') -Raw) -match 'repairing') 'repair noted in the log'

# 3. Tools
Set-Content -LiteralPath (Join-Path $root 'config/rig-settings.ini') -Value ((Get-Content (Join-Path $root 'config/rig-settings.ini') -Raw).Replace('RigLanSubnet = 10.20.30.0/24', 'RigLanSubnet = 10.20.30.0/24, 10.20.40.0/24')) -NoNewline
Check ((Run 'Apply-Settings') -eq 0) 'Apply-Settings exits 0'
Check (@((Get-DryState).rules | Where-Object { $_.Remote -eq '10.20.30.0/24,10.20.40.0/24' }).Count -eq 1) 'Apply-Settings widened the HMI rule'
Check ((Run 'Check-Health') -eq 0) 'Check-Health exits 0'
Check (@(Get-ChildItem (Join-Path $root 'logs') -Filter 'health-*.html').Count -ge 1) 'health report written'
Check ((Run 'Backup-Now') -eq 0) 'Backup-Now exits 0'
Check ((Run 'Collect-Logs') -eq 0) 'Collect-Logs exits 0'
$zip = @(Get-ChildItem (Join-Path $tmp 'home/Desktop') -Filter 'AHWR-logs-*.zip')
Check ($zip.Count -eq 1) 'logs zip on the desktop'
if ($zip.Count) {
    $x = Join-Path $tmp 'logs-zip'; Expand-Archive $zip[0].FullName $x
    $red = Get-Content (Join-Path $x 'settings-redacted.env') -Raw
    Check ($red -match 'PGPASSWORD=\*\*\*' -and $red -match 'DEVICE_TOKEN=\*\*\*' -and $red -notmatch $firstJwt) 'secrets left out of the logs zip'
}

# 4. Update with the same package; then a failing update that rolls back
Check ((Run 'Update') -eq 0) 'Update (same version) exits 0'
Check (@(Get-ChildItem (Join-Path $root 'rollback') -Directory).Count -eq 1) 'one rollback copy kept'
Set-DryState { param($s) $s.httpOk = $false }
Set-Content (Join-Path $root 'app/backend/MARKER.txt') 'previous version'
$code = Run 'Update'
Set-DryState { param($s) $s.httpOk = $true }
Check ($code -ne 0) 'failing update exits non-zero'
Check ((Test-Path (Join-Path $root 'app/backend/MARKER.txt')) -and (Test-Path (Join-Path $root 'app/backend/server.js'))) 'rollback restored the previous application'
Check ((Get-Content @(Get-ChildItem (Join-Path $root 'logs') -Filter 'update-*.html' | Sort-Object LastWriteTime)[-1].FullName -Raw) -match 'UPDATE FAILED') 'update report says UPDATE FAILED'

# 5. Uninstall (data kept), reinstall on the kept data, purge
Set-DryState { param($s) $s.answers = @('UNINSTALL') }
Check ((Run 'Uninstall') -eq 0) 'Uninstall exits 0'
Check (-not (Test-Path $root) -and (Test-Path (Join-Path $dataRoot 'data/pgdata/PG_VERSION')) -and (Test-Path (Join-Path $dataRoot 'kept-config/settings.env'))) 'programs removed; data and settings kept'
Check (@((Get-DryState).services.Keys).Count -eq 0 -and @((Get-DryState).rules).Count -eq 0) 'services and firewall rules removed'
$code = Run 'Install'
Check ($code -eq 0 -and (Get-Settings)['JWT_SECRET'] -eq $firstJwt) 'reinstall reuses the kept settings for the kept database'
$ini2 = Join-Path $root 'config/rig-settings.ini'
Set-DryState { param($s) $s.answers = @('UNINSTALL', 'AHWR-50-III') }
Check ((Run 'Uninstall' '/purge') -eq 0) 'Uninstall /purge exits 0'
Check (-not (Test-Path $root) -and -not (Test-Path $dataRoot)) 'purge removed programs and data'

Remove-Item Env:\DRY_STATE, Env:\DRY_PACKAGE, Env:\DRY_ARG, Env:\AHWR_INSTALL_ROOT -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $tmp -Recurse -Force
Write-Host ''
$color = 'Green'; if ($script:fail) { $color = 'Red' }
Write-Host "dry run: $($script:pass) passed, $($script:fail) failed" -ForegroundColor $color
exit ([int][bool]$script:fail)
