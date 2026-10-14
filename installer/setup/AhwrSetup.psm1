# Shared functions of the AHWR-150 EDGE single-click installer (Install.bat) and
# its tools (Apply-Settings, Check-Health, Update, Backup-Now, Restore-Records,
# Collect-Logs, Uninstall). Windows PowerShell 5.1 compatible; ASCII only.
#
# Layout on the edge PC
#   C:\AHWR\            programs: app\, runtime\, scripts, settings.env, config\, certs\, tools\
#   <DataDrive>\AHWR\   data\ (database in data\pgdata, records, upload buffer), logs\, backups\
#                       reached from C:\AHWR\data, logs and backups (directory junctions)
Set-StrictMode -Version 2.0
# Module functions do not see the caller's preference: stop on errors here too.
$ErrorActionPreference = 'Stop'

$script:Results = New-Object System.Collections.ArrayList
$script:Stages = New-Object System.Collections.ArrayList
$script:CurrentStage = ''
$script:LogPath = $null

$AhwrServices = @('AHWR-PostgreSQL', 'AHWR-Telegraf', 'AHWR-Backend', 'AHWR-BOP-Collector')
$AhwrPorts = [ordered]@{
    5432 = 'PostgreSQL (this PC only)'
    8080 = 'HMI and API (rig LAN)'
    8888 = 'Telegraf health (this PC only)'
    8186 = 'Telegraf listener for the BOP collector (this PC only)'
}
$AhwrFirewallGroup = 'AHWR-EDGE'
$AhwrSecretIniKeys = @(@('CMF', 'DeviceToken'), @('Domain', 'BindPassword'), @('BOP', 'KepwarePassword'))
$RigIdPattern = '^[A-Za-z0-9_.\-]{1,64}$'

# --- Paths -----------------------------------------------------------------------
function Get-AhwrInstallRoot {
    if ($env:AHWR_INSTALL_ROOT) { return $env:AHWR_INSTALL_ROOT }
    return 'C:\AHWR'
}

function Join-Parts([string]$Base) {
    # Join-Path with several parts (Windows PowerShell 5.1 takes only one child).
    $path = $Base
    foreach ($part in $args) { $path = Join-Path $path $part }
    return $path
}

function Get-DesktopPath { return [Environment]::GetFolderPath('Desktop') }
function Get-CurrentUserName { return [Security.Principal.WindowsIdentity]::GetCurrent().Name }
function Get-CurrentUserSid { return [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }

function Test-IsAdministrator {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Restart-Elevated([string]$ScriptPath, [string[]]$Arguments = @()) {
    # Relaunch this script in an elevated window; it pauses at the end so its output stays visible.
    $argList = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $ScriptPath)) + $Arguments + @('-PauseAtEnd')
    Write-Host 'Administrator rights are needed: accept the Windows prompt. The work continues in the new window.' -ForegroundColor Cyan
    try {
        $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs -Wait -PassThru
    } catch {
        Write-Host 'Administrator approval was cancelled. Nothing was changed.' -ForegroundColor Red
        exit 1
    }
    exit $proc.ExitCode
}

# --- Log, stages and report ----------------------------------------------------------
function Set-SetupLog([string]$Path) {
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) { $null = New-Item -ItemType Directory -Force -Path $dir }
    if ($script:LogPath -and ($script:LogPath -ne $Path) -and (Test-Path -LiteralPath $script:LogPath)) {
        Get-Content -LiteralPath $script:LogPath | Add-Content -LiteralPath $Path -Encoding UTF8
        Remove-Item -LiteralPath $script:LogPath -Force -ErrorAction SilentlyContinue
    }
    $script:LogPath = $Path
}

function Write-Log([string]$Message) {
    if (-not $script:LogPath) { return }
    $line = '{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $Message
    Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8
}

function Add-Check([string]$Name, [string]$Status, [string]$Detail = '') {
    if ($Status -notin @('OK', 'WARNING', 'FAILED', 'INFO')) { throw "Unknown status $Status" }
    $null = $script:Results.Add([pscustomobject]@{ Stage = $script:CurrentStage; Check = $Name; Status = $Status; Detail = $Detail })
    Write-Log ('{0,-8} {1}  {2}' -f $Status, $Name, $Detail)
    $colors = @{ OK = 'Green'; WARNING = 'Yellow'; FAILED = 'Red'; INFO = 'Gray' }
    $text = '      {0,-8} {1}' -f $Status, $Name
    if ($Detail) { $text += ': ' + $Detail }
    Write-Host $text -ForegroundColor $colors[$Status]
}

function Get-CheckResults { return @($script:Results) }
function Get-StageResults { return @($script:Stages) }
function Reset-CheckResults { $script:Results.Clear(); $script:Stages.Clear() }

function Invoke-Stage([int]$Number, [int]$Total, [string]$Name, [scriptblock]$Body) {
    $script:CurrentStage = "$Number. $Name"
    Write-Host ''
    Write-Host ('[{0}/{1}] {2}' -f $Number, $Total, $Name) -ForegroundColor Cyan
    Write-Log "=== [$Number/$Total] $Name"
    $before = $script:Results.Count
    $failure = $null
    try { & $Body } catch {
        $failure = $_.Exception.Message
        Write-Log ($_ | Out-String)
        Add-Check 'Stopped' 'FAILED' $failure
    }
    $mine = @($script:Results | Select-Object -Skip $before)
    $status = 'OK'
    if (@($mine | Where-Object { $_.Status -eq 'WARNING' }).Count) { $status = 'WARNING' }
    if (@($mine | Where-Object { $_.Status -eq 'FAILED' }).Count) { $status = 'FAILED' }
    $null = $script:Stages.Add([pscustomobject]@{ Number = $Number; Name = $Name; Status = $status })
    $color = @{ OK = 'Green'; WARNING = 'Yellow'; FAILED = 'Red' }[$status]
    Write-Host ('[{0}/{1}] {2}: {3}' -f $Number, $Total, $Name, $status) -ForegroundColor $color
    if ($status -eq 'FAILED') {
        if (-not $failure) { $failure = (@($mine | Where-Object { $_.Status -eq 'FAILED' })[0]).Detail }
        throw "Stage $Number ($Name) failed: $failure"
    }
}

function ConvertTo-Html([string]$Text) { return [System.Net.WebUtility]::HtmlEncode($Text) }

function Write-SetupReport([string]$Path, [string]$Title, [string]$Outcome, $Facts) {
    $rows = New-Object System.Text.StringBuilder
    foreach ($r in $script:Results) {
        $null = $rows.AppendFormat('<tr class="{0}"><td>{1}</td><td>{2}</td><td><b>{0}</b></td><td>{3}</td></tr>', $r.Status, (ConvertTo-Html $r.Stage), (ConvertTo-Html $r.Check), (ConvertTo-Html $r.Detail))
    }
    $stageRows = New-Object System.Text.StringBuilder
    foreach ($s in $script:Stages) {
        $null = $stageRows.AppendFormat('<tr class="{0}"><td>{1}</td><td>{2}</td><td><b>{0}</b></td></tr>', $s.Status, $s.Number, (ConvertTo-Html $s.Name))
    }
    $factRows = New-Object System.Text.StringBuilder
    if ($Facts) { foreach ($k in $Facts.Keys) { $null = $factRows.AppendFormat('<tr><th>{0}</th><td>{1}</td></tr>', (ConvertTo-Html $k), (ConvertTo-Html ([string]$Facts[$k]))) } }
    $html = @"
<!doctype html><html><head><meta charset="utf-8"><title>$(ConvertTo-Html $Title)</title>
<style>body{font:14px Segoe UI,Arial,sans-serif;margin:24px;color:#1c2422}h1{font-size:22px}table{border-collapse:collapse;margin:12px 0 24px}
td,th{border:1px solid #ccd;padding:5px 9px;text-align:left;vertical-align:top}th{background:#eef1ee}
tr.OK b{color:#2b7a4b}tr.WARNING b{color:#a05f00}tr.FAILED b{color:#b3261e}tr.INFO b{color:#59645f}.outcome{font-size:18px;font-weight:600}</style></head><body>
<h1>$(ConvertTo-Html $Title)</h1><p class="outcome">$(ConvertTo-Html $Outcome)</p>
<table>$factRows</table><h2>Stages</h2><table><tr><th>#</th><th>Stage</th><th>Result</th></tr>$stageRows</table>
<h2>Checks</h2><table><tr><th>Stage</th><th>Check</th><th>Result</th><th>Detail</th></tr>$rows</table>
<p>Generated $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') on $(ConvertTo-Html $env:COMPUTERNAME).</p></body></html>
"@
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) { $null = New-Item -ItemType Directory -Force -Path $dir }
    Write-Utf8File $Path @($html)
}

# --- Files ---------------------------------------------------------------------------
function Resolve-FsPath([string]$Path) {
    # A full file-system path for .NET calls (PowerShell drives and relative paths resolved).
    return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
}

function Write-Utf8File([string]$Path, [string[]]$Lines) {
    # UTF-8 without BOM, CRLF line ends.
    $Path = Resolve-FsPath $Path
    $text = ($Lines -join "`r`n") + "`r`n"
    [IO.File]::WriteAllText($Path, $text, (New-Object Text.UTF8Encoding($false)))
}

function Read-IniFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { throw "Settings file not found: $Path" }
    $Path = Resolve-FsPath $Path
    $ini = @{}
    $section = ''
    $lineNo = 0
    foreach ($raw in [IO.File]::ReadAllLines($Path)) {
        $lineNo++
        $line = $raw.TrimStart([char]0xFEFF).Trim()
        if ($line -eq '' -or $line.StartsWith(';') -or $line.StartsWith('#')) { continue }
        if ($line -match '^\[([^\]]+)\]$') {
            $section = $matches[1].Trim()
            if (-not $ini.ContainsKey($section)) { $ini[$section] = @{} }
            continue
        }
        $eq = $line.IndexOf('=')
        if ($eq -lt 1) { throw "rig-settings.ini line ${lineNo}: expected Key = value, found '$line'." }
        if (-not $section) { throw "rig-settings.ini line ${lineNo}: '$line' is not inside a [section]." }
        $ini[$section][$line.Substring(0, $eq).Trim()] = $line.Substring($eq + 1).Trim()
    }
    return $ini
}

function Get-IniValue($Ini, [string]$Section, [string]$Key, [string]$Default = '') {
    if ($Ini.ContainsKey($Section) -and $Ini[$Section].ContainsKey($Key)) {
        $value = [string]$Ini[$Section][$Key]
        if ($value -ne '') { return $value }
    }
    return $Default
}

function Set-IniValue([string]$Path, [string]$Section, [string]$Key, [string]$Value) {
    # Rewrite one value in place, keeping comments and layout.
    $Path = Resolve-FsPath $Path
    $lines = [IO.File]::ReadAllLines($Path)
    $current = ''
    for ($i = 0; $i -lt $lines.Length; $i++) {
        $t = $lines[$i].TrimStart([char]0xFEFF).Trim()
        if ($t -match '^\[([^\]]+)\]$') { $current = $matches[1].Trim(); continue }
        if ($current -ieq $Section -and $t -match '^([^=;#]+)=') {
            if ($matches[1].Trim() -ieq $Key) {
                $indent = $lines[$i].Substring(0, $lines[$i].Length - $lines[$i].TrimStart().Length)
                $lines[$i] = '{0}{1} = {2}' -f $indent, $matches[1].Trim(), $Value
                Write-Utf8File $Path $lines
                return $true
            }
        }
    }
    return $false
}

function Clear-IniSecrets([string]$Path) {
    # After a successful install the secrets live only in the protected settings.env.
    $cleared = @()
    if (-not (Test-Path -LiteralPath $Path)) { return $cleared }
    $ini = Read-IniFile $Path
    foreach ($pair in $AhwrSecretIniKeys) {
        if (Get-IniValue $ini $pair[0] $pair[1]) {
            if (Set-IniValue $Path $pair[0] $pair[1] '') { $cleared += "$($pair[0]).$($pair[1])" }
        }
    }
    return $cleared
}

function Read-EnvFile([string]$Path) {
    $values = [ordered]@{}
    if (-not (Test-Path -LiteralPath $Path)) { return $values }
    $Path = Resolve-FsPath $Path
    foreach ($raw in [IO.File]::ReadAllLines($Path)) {
        $line = $raw.TrimStart([char]0xFEFF)
        if ($line -match '^\s*([^#=]+)=(.*)$') { $values[$matches[1].Trim()] = $matches[2] }
    }
    return $values
}

function Update-EnvFile([string]$Path, $Updates, [string[]]$Remove = @(), [string]$Header = '# Added by the AHWR-EDGE installer') {
    # Set KEY=value lines in place; append keys that are new; keep comments and order.
    $Path = Resolve-FsPath $Path
    $lines = New-Object System.Collections.ArrayList
    if (Test-Path -LiteralPath $Path) { foreach ($l in [IO.File]::ReadAllLines($Path)) { $null = $lines.Add($l.TrimStart([char]0xFEFF)) } }
    $done = @{}
    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
        if ($lines[$i] -match '^\s*([^#=]+)=(.*)$') {
            $key = $matches[1].Trim()
            if ($Remove -contains $key) { $lines.RemoveAt($i); continue }
            if ($Updates.Contains($key)) {
                if ($done.ContainsKey($key)) { $lines.RemoveAt($i); continue }   # drop duplicates, keep the last
                $lines[$i] = "$key=$($Updates[$key])"
                $done[$key] = $true
            }
        }
    }
    $new = @($Updates.Keys | Where-Object { -not $done.ContainsKey($_) })
    if ($new.Count) {
        if ($lines.Count) { $null = $lines.Add('') }
        $null = $lines.Add($Header)
        foreach ($key in $new) { $null = $lines.Add("$key=$($Updates[$key])") }
    }
    Write-Utf8File $Path ([string[]]$lines.ToArray())
}

function Copy-SharedFile([string]$Source, [string]$Destination) {
    # Copy a file another process still has open for writing (service logs).
    $Source = Resolve-FsPath $Source; $Destination = Resolve-FsPath $Destination
    $in = [IO.File]::Open($Source, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
    try {
        $out = [IO.File]::Create($Destination)
        try { $in.CopyTo($out) } finally { $out.Dispose() }
    } finally { $in.Dispose() }
}

# --- Secrets -----------------------------------------------------------------------------
function Get-RandomBytes([int]$Count) {
    $bytes = New-Object byte[] $Count
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ,$bytes
}

function New-Secret([int]$Bytes = 32) {
    return -join ((Get-RandomBytes $Bytes) | ForEach-Object { $_.ToString('x2') })
}

function New-Password([int]$Length = 20) {
    # Letters and digits without look-alikes; at least one upper, lower and digit.
    $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
    $limit = 256 - (256 % $alphabet.Length)   # reject bytes above a multiple of the alphabet size: no bias
    while ($true) {
        $chars = New-Object System.Text.StringBuilder
        while ($chars.Length -lt $Length) {
            foreach ($b in (Get-RandomBytes 64)) {
                if ($b -lt $limit -and $chars.Length -lt $Length) { $null = $chars.Append($alphabet[$b % $alphabet.Length]) }
            }
        }
        $p = $chars.ToString()
        if ($p -cmatch '[A-Z]' -and $p -cmatch '[a-z]' -and $p -match '[0-9]') { return $p }
    }
}

# --- Validation ------------------------------------------------------------------------------
function Test-Ipv4([string]$Text) {
    if ($Text -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { return $false }
    foreach ($octet in $Text.Split('.')) { if ([int]$octet -gt 255) { return $false } }
    return $true
}

function Test-Ipv4Cidr([string]$Text) {
    if ($Text -notmatch '^([0-9.]+)/(\d{1,2})$') { return $false }
    $address = $matches[1]; $bits = [int]$matches[2]
    return ((Test-Ipv4 $address) -and $bits -le 32)
}

function Test-Placeholder([string]$Text) { return ($Text -match '[<>]') }

function Get-UriParts([string]$Url, [int]$DefaultPort) {
    $uri = $null
    if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$uri)) { return $null }
    $port = $uri.Port
    if ($port -le 0) { $port = $DefaultPort }
    return [pscustomobject]@{ Scheme = $uri.Scheme.ToLowerInvariant(); Host = $uri.Host; Port = $port }
}

function Test-RigSettings($Ini, $Existing = $null) {
    # Validate rig-settings.ini. Returns Errors, Warnings and the normalised values.
    if (-not $Existing) { $Existing = [ordered]@{} }
    $errors = New-Object System.Collections.ArrayList
    $warnings = New-Object System.Collections.ArrayList
    $v = [ordered]@{}
    $domainOn = (Get-IniValue $Ini 'Domain' 'Enabled' 'no') -match '^(?i)(yes|true|1|on)$'
    foreach ($section in @($Ini.Keys)) {
        if ($section -ieq 'Domain' -and -not $domainOn) { continue }   # examples may stay while domain login is off
        foreach ($key in @($Ini[$section].Keys)) {
            $value = [string]$Ini[$section][$key]
            if ($value -and (Test-Placeholder $value)) { $null = $errors.Add("[$section] $key still holds an example placeholder ('$value').") }
        }
    }

    $v.DeviceId = Get-IniValue $Ini 'Rig' 'DeviceId'
    if (-not $v.DeviceId) { $null = $errors.Add('[Rig] DeviceId is required (the rig name exactly as in the asset list, e.g. AHWR-50-III).') }
    elseif ($v.DeviceId -notmatch $RigIdPattern) { $null = $errors.Add("[Rig] DeviceId '$($v.DeviceId)' may only use 1-64 letters, digits, dot, underscore or hyphen.") }
    $v.Asset = Get-IniValue $Ini 'Rig' 'Asset'
    $v.DataDrive = (Get-IniValue $Ini 'Rig' 'DataDrive' 'D:').ToUpperInvariant()
    if ($v.DataDrive -notmatch '^[A-Z]:$') { $null = $errors.Add("[Rig] DataDrive '$($v.DataDrive)' must be a drive letter such as D:.") }

    $v.RigLanSubnet = @((Get-IniValue $Ini 'Network' 'RigLanSubnet').Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if (-not $v.RigLanSubnet.Count) { $null = $errors.Add('[Network] RigLanSubnet is required (only these machines may open the HMI), e.g. 10.20.30.0/24.') }
    foreach ($net in $v.RigLanSubnet) { if (-not (Test-Ipv4Cidr $net)) { $null = $errors.Add("[Network] RigLanSubnet '$net' is not an IPv4 subnet such as 10.20.30.0/24.") } }
    $v.PlcAddress = Get-IniValue $Ini 'Network' 'PlcAddress'
    if (-not (Test-Ipv4 $v.PlcAddress)) { $null = $errors.Add("[Network] PlcAddress '$($v.PlcAddress)' is not an IPv4 address.") }
    $protocol = Get-IniValue $Ini 'Network' 'PlcProtocol' 'S7'
    switch -Regex ($protocol) {
        '^(?i)s7$' { $v.PlcProtocol = 'S7'; $v.PlcPort = 102 }
        '^(?i)modbus$' { $v.PlcProtocol = 'Modbus'; $v.PlcPort = 502 }
        default { $v.PlcProtocol = $protocol; $v.PlcPort = 0; $null = $errors.Add("[Network] PlcProtocol '$protocol' must be S7 or Modbus.") }
    }

    $v.CentralUrl = (Get-IniValue $Ini 'CMF' 'CentralUrl').TrimEnd('/')
    if ($v.CentralUrl) {
        $u = Get-UriParts $v.CentralUrl 443
        if (-not $u -or $u.Scheme -ne 'https') { $null = $errors.Add("[CMF] CentralUrl '$($v.CentralUrl)' must be an https:// address.") }
    } else { $null = $warnings.Add('[CMF] CentralUrl is empty: nothing is uploaded to the CMF until it is set (Apply-Settings.bat).') }
    $v.DeviceToken = Get-IniValue $Ini 'CMF' 'DeviceToken'
    if ($v.DeviceToken -and ($v.DeviceToken.Length -lt 8 -or $v.DeviceToken -match '\s')) { $null = $errors.Add('[CMF] DeviceToken looks wrong (at least 8 characters, no spaces).') }
    $haveToken = [bool]($v.DeviceToken -or ($Existing.Contains('DEVICE_TOKEN') -and $Existing['DEVICE_TOKEN'] -and $Existing['DEVICE_TOKEN'] -notmatch 'CHANGE_ME'))
    $v.HaveToken = $haveToken
    if ($v.CentralUrl -and -not $haveToken) { $null = $warnings.Add('[CMF] DeviceToken is empty: the upload starts once it is added (Apply-Settings.bat).') }
    $v.EtpUrl = Get-IniValue $Ini 'CMF' 'EtpUrl'
    if ($v.EtpUrl) {
        $u = Get-UriParts $v.EtpUrl 443
        if (-not $u -or $u.Scheme -ne 'wss') { $null = $errors.Add("[CMF] EtpUrl '$($v.EtpUrl)' must be a wss:// address.") }
    }

    $v.DomainEnabled = (Get-IniValue $Ini 'Domain' 'Enabled' 'no') -match '^(?i)(yes|true|1|on)$'
    foreach ($key in @('DomainController', 'Domain', 'BindAccount', 'BindPassword', 'SearchBase', 'AdminGroup', 'OperatorGroup', 'ViewerGroup')) { $v[$key] = Get-IniValue $Ini 'Domain' $key }
    if ($v.DomainEnabled) {
        foreach ($key in @('DomainController', 'Domain', 'BindAccount', 'SearchBase', 'AdminGroup', 'OperatorGroup')) {
            if (-not $v[$key]) { $null = $errors.Add("[Domain] $key is required when Enabled = yes.") }
        }
        if (-not $v.BindPassword -and -not ($Existing.Contains('LDAP_BIND_PASSWORD') -and $Existing['LDAP_BIND_PASSWORD'])) { $null = $errors.Add('[Domain] BindPassword is required when Enabled = yes.') }
        if ($v.DomainController) {
            $u = Get-UriParts $v.DomainController 636
            if (-not $u -or $u.Scheme -ne 'ldaps') { $null = $errors.Add("[Domain] DomainController '$($v.DomainController)' must be an ldaps:// address, e.g. ldaps://dc01.example.local:636.") }
        }
    }

    $v.KepwareUrl = Get-IniValue $Ini 'BOP' 'KepwareUrl' 'opc.tcp://localhost:49320'
    if ($v.KepwareUrl -notmatch '^(?i)opc\.tcp://') { $null = $errors.Add("[BOP] KepwareUrl '$($v.KepwareUrl)' must start with opc.tcp://.") }
    $v.KepwareUser = Get-IniValue $Ini 'BOP' 'KepwareUser'
    $v.KepwarePassword = Get-IniValue $Ini 'BOP' 'KepwarePassword'

    $v.Checks = (Get-IniValue $Ini 'Install' 'Checks' 'strict').ToLowerInvariant()
    if ($v.Checks -notin @('strict', 'relaxed')) { $null = $errors.Add("[Install] Checks must be strict or relaxed, not '$($v.Checks)'.") }

    return [pscustomobject]@{ Errors = @($errors); Warnings = @($warnings); Values = $v }
}

function ConvertTo-EdgeSettings($Values, $Existing, [string]$Root, [string]$CaPemPath = '') {
    # settings.env entries managed from rig-settings.ini. Secrets left blank in the
    # ini keep their stored value; generated secrets are kept on a repair.
    $s = [ordered]@{}
    $s['DEVICE_ID'] = $Values.DeviceId
    $s['CENTRAL_URL'] = $Values.CentralUrl
    if ($Values.DeviceToken) { $s['DEVICE_TOKEN'] = $Values.DeviceToken }
    $syncOn = [bool]($Values.CentralUrl -and $Values.HaveToken)
    $s['SYNC_ENABLED'] = $syncOn.ToString().ToLowerInvariant()
    $s['ETP_URL'] = $Values.EtpUrl
    $s['ETP_ENABLED'] = ([bool]($Values.EtpUrl -and $Values.HaveToken)).ToString().ToLowerInvariant()
    $s['ETP_MODE'] = 'store'
    $s['ETP_AUTH'] = 'basic'
    if ($Values.DomainEnabled) {
        $s['AUTH_MODE'] = 'both'   # domain accounts plus the local admin
        $s['LDAP_URL'] = $Values.DomainController
        $s['LDAP_STARTTLS'] = 'false'   # ldaps:// is already TLS
        $s['LDAP_TLS_REJECT_UNAUTHORIZED'] = 'true'
        $s['LDAP_BIND_DN'] = $Values.BindAccount
        if ($Values.BindPassword) { $s['LDAP_BIND_PASSWORD'] = $Values.BindPassword }
        $s['LDAP_SEARCH_BASE'] = $Values.SearchBase
        $s['LDAP_DOMAIN'] = $Values.Domain
        $s['LDAP_ROLE_ADMIN'] = $Values.AdminGroup
        $s['LDAP_ROLE_OPERATOR'] = $Values.OperatorGroup
        $s['LDAP_ROLE_VIEWER'] = $Values.ViewerGroup
        $s['LDAP_DEFAULT_ROLE'] = 'viewer'
    } else {
        $s['AUTH_MODE'] = 'local'
        $s['LDAP_URL'] = ''
    }
    $s['KEPWARE_OPCUA_URL'] = $Values.KepwareUrl
    $s['KEPWARE_OPCUA_USERNAME'] = $Values.KepwareUser
    if ($Values.KepwarePassword) { $s['KEPWARE_OPCUA_PASSWORD'] = $Values.KepwarePassword }
    if ($CaPemPath) { $s['NODE_EXTRA_CA_CERTS'] = $CaPemPath }

    # Created once: kept on a repair or update.
    $once = [ordered]@{
        NODE_ENV = 'production'; PORT = '8080'; HOST = ''; DATA_SOURCE = 'plc'
        PG_MODE = 'bundled'; PGHOST = '127.0.0.1'; PGPORT = '5432'; PGDATABASE = 'ahwr_edge'; PGUSER = 'ahwr_app'
        SYNC_BATCH_SECONDS = '5'; SYNC_BUFFER_DAYS = '15'
        ETP_STREAM_SECONDS = '1'; ETP_BACKFILL_HOURS = '24'; ETP_TAIL_LAG_SECONDS = '5'
        ALLOW_INSECURE_TRANSPORT = 'false'
        KEPWARE_SECURITY_MODE = 'None'; KEPWARE_SECURITY_POLICY = 'None'
        BOP_RECONNECT_INITIAL_SECONDS = '2'; BOP_RECONNECT_MAX_SECONDS = '60'
        WITSML_MAX_ROWS = '50000'
    }
    foreach ($key in $once.Keys) { if (-not $Existing.Contains($key)) { $s[$key] = $once[$key] } }
    foreach ($key in @('JWT_SECRET', 'PGPASSWORD', 'TELEGRAF_DB_PASSWORD', 'PG_SUPERUSER_PASSWORD')) {
        if (-not ($Existing.Contains($key) -and $Existing[$key] -and $Existing[$key] -notmatch 'CHANGE_ME')) { $s[$key] = New-Secret }
    }
    return $s
}

# --- Network --------------------------------------------------------------------------------
function Test-TcpConnect([string]$HostName, [int]$Port, [int]$TimeoutMs = 3000) {
    $client = New-Object Net.Sockets.TcpClient
    try {
        $task = $client.ConnectAsync($HostName, $Port)
        if ($task.Wait($TimeoutMs)) { return $client.Connected }
        return $false
    } catch { return $false } finally { $client.Dispose() }
}

function Get-PortOwner([int]$Port) {
    $conn = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $conn) { return $null }
    $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    $path = $null
    if ($proc) { try { $path = $proc.Path } catch { $path = $null } }
    $name = 'PID ' + $conn.OwningProcess
    if ($proc) { $name = $proc.ProcessName }
    return [pscustomobject]@{ Port = $Port; ProcessId = $conn.OwningProcess; Name = $name; Path = $path }
}

# --- Package checksums --------------------------------------------------------------------------
function Get-PackageChecksumProblems([string]$PackageRoot) {
    $problems = New-Object System.Collections.ArrayList
    $sumFile = Resolve-FsPath (Join-Path $PackageRoot 'SHA256SUMS.txt')
    if (-not (Test-Path -LiteralPath $sumFile)) { $null = $problems.Add('SHA256SUMS.txt is missing'); return @($problems) }
    $sep = [IO.Path]::DirectorySeparatorChar
    foreach ($line in [IO.File]::ReadAllLines($sumFile)) {
        if ($line -notmatch '^([0-9a-fA-F]{64})\s+\*?(.+)$') { continue }
        $expected = $matches[1].ToUpperInvariant(); $rel = $matches[2].Trim()
        $path = Join-Path $PackageRoot ($rel.Replace('/', $sep).Replace('\', $sep))
        if (-not (Test-Path -LiteralPath $path)) { $null = $problems.Add("missing: $rel"); continue }
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash -ne $expected) { $null = $problems.Add("changed: $rel") }
    }
    return @($problems)
}

# --- Components ---------------------------------------------------------------------------------
function Expand-ZipTo([string]$ZipPath, [string]$Destination, [string]$StripPrefix = '', [string[]]$ExcludePrefixes = @(), [string[]]$OnlyPrefixes = @()) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $ZipPath = Resolve-FsPath $ZipPath
    $root = (Resolve-FsPath $Destination).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    $null = New-Item -ItemType Directory -Force -Path $root
    $ic = [StringComparison]::OrdinalIgnoreCase
    $zip = [IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if ($StripPrefix) {
                if (-not $name.StartsWith($StripPrefix, $ic)) { continue }
                $name = $name.Substring($StripPrefix.Length)
            }
            if (-not $name) { continue }
            if ($OnlyPrefixes.Count -and -not @($OnlyPrefixes | Where-Object { $name.StartsWith($_, $ic) }).Count) { continue }
            if (@($ExcludePrefixes | Where-Object { $name.StartsWith($_, $ic) }).Count) { continue }
            $target = [IO.Path]::GetFullPath((Join-Path $root $name))
            if (-not $target.StartsWith($root, $ic)) { throw "Unsafe path '$($entry.FullName)' in $ZipPath" }
            if ($name.EndsWith('/')) { $null = New-Item -ItemType Directory -Force -Path $target; continue }
            $parent = Split-Path -Parent $target
            if (-not (Test-Path -LiteralPath $parent)) { $null = New-Item -ItemType Directory -Force -Path $parent }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
        }
    } finally { $zip.Dispose() }
}

function Read-ComponentManifest([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    return @((Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json).components)
}

function Get-InstalledComponents([string]$Root) {
    $marker = Join-Parts $Root 'runtime' 'components.json'
    $map = @{}
    if (Test-Path -LiteralPath $marker) {
        foreach ($p in (Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json).PSObject.Properties) { $map[$p.Name] = [string]$p.Value }
    }
    return $map
}

function Set-InstalledComponent([string]$Root, [string]$Name, [string]$Sha256) {
    $map = Get-InstalledComponents $Root
    $map[$Name] = $Sha256
    $dir = Join-Path $Root 'runtime'
    if (-not (Test-Path -LiteralPath $dir)) { $null = New-Item -ItemType Directory -Force -Path $dir }
    $ordered = [ordered]@{}
    foreach ($k in ($map.Keys | Sort-Object)) { $ordered[$k] = $map[$k] }
    Write-Utf8File (Join-Path $dir 'components.json') @(($ordered | ConvertTo-Json))
}

function Install-PythonEmbedded([string]$EmbedZip, [string]$WheelDir, [string]$PythonDir) {
    Expand-ZipTo $EmbedZip $PythonDir
    $site = Join-Parts $PythonDir 'Lib' 'site-packages'
    $null = New-Item -ItemType Directory -Force -Path $site
    foreach ($wheel in @(Get-ChildItem -LiteralPath $WheelDir -Filter '*.whl')) { Expand-ZipTo $wheel.FullName $site }
    # The embeddable package ignores site-packages unless its ._pth file lists it.
    $pth = Get-ChildItem -LiteralPath $PythonDir -Filter 'python*._pth' | Select-Object -First 1
    if (-not $pth) { throw "No python*._pth file in $PythonDir" }
    $stdlibZip = (Get-ChildItem -LiteralPath $PythonDir -Filter 'python*.zip' | Select-Object -First 1).Name
    Write-Utf8File $pth.FullName @($stdlibZip, '.', 'Lib\site-packages', 'import site')
}

# --- Folders and rights ---------------------------------------------------------------------------
function Test-ReparsePoint([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    return [bool]($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint))
}

function Get-JunctionTarget([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if (-not $item) { return $null }
    $target = @($item.Target) | Select-Object -First 1
    if ($target) { return ([string]$target).TrimEnd('\') }
    return $null
}

function New-DataJunction([string]$Link, [string]$Target, [switch]$MoveExisting) {
    if (-not (Test-Path -LiteralPath $Target)) { $null = New-Item -ItemType Directory -Force -Path $Target }
    if (Test-Path -LiteralPath $Link) {
        if (Test-ReparsePoint $Link) {
            if ((Get-JunctionTarget $Link) -ieq $Target.TrimEnd('\')) { return }
            & cmd.exe /c rmdir "$Link" | Out-Null
        } else {
            $children = @(Get-ChildItem -LiteralPath $Link -Force)
            if ($children.Count -and -not $MoveExisting) { throw "$Link already holds files. Move them to $Target, then run the installer again." }
            foreach ($child in $children) { Move-Item -LiteralPath $child.FullName -Destination $Target -Force }
            Remove-Item -LiteralPath $Link -Force
        }
    }
    & cmd.exe /c mklink /J "$Link" "$Target" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not link $Link to $Target." }
}

function Remove-DataJunction([string]$Link) {
    if (Test-ReparsePoint $Link) { & cmd.exe /c rmdir "$Link" | Out-Null }
}

function Set-RestrictedAcl([string]$Path, [string[]]$ReadSids = @()) {
    # Administrators, SYSTEM and the installing user: full control. Service accounts: read.
    # The installing user stays listed because PostgreSQL's initdb and pg_ctl drop
    # administrator rights and still need to write the database folder.
    $me = Get-CurrentUserSid
    & icacls.exe $Path /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' "*${me}:(OI)(CI)F" /C /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not set the access rights of $Path." }
    foreach ($sid in $ReadSids) {
        & icacls.exe $Path /grant "*${sid}:(OI)(CI)RX" /C /Q | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Could not grant read access on $Path." }
    }
}

function ConvertTo-PemCertificate([string]$CertPath, [string]$PemPath) {
    # NODE_EXTRA_CA_CERTS needs PEM; the CA file may come as DER or PEM.
    $cert = New-Object Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList $CertPath
    $b64 = [Convert]::ToBase64String($cert.RawData)
    $lines = @('-----BEGIN CERTIFICATE-----')
    for ($i = 0; $i -lt $b64.Length; $i += 64) { $lines += $b64.Substring($i, [Math]::Min(64, $b64.Length - $i)) }
    $lines += '-----END CERTIFICATE-----'
    Write-Utf8File $PemPath $lines
    return $cert
}

# --- Windows configuration ---------------------------------------------------------------------------
function Set-HmiFirewall([string[]]$Subnets, [string]$NodeExe, [int]$Port = 8080) {
    Get-NetFirewallRule -Group $AhwrFirewallGroup -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    $null = New-NetFirewallRule -DisplayName 'AHWR-EDGE HMI (rig LAN only)' -Group $AhwrFirewallGroup -Direction Inbound -Action Allow `
        -Protocol TCP -LocalPort $Port -RemoteAddress $Subnets -Program $NodeExe -Profile Any
    $null = New-NetFirewallRule -DisplayName 'AHWR-EDGE local services (no network access)' -Group $AhwrFirewallGroup -Direction Inbound -Action Block `
        -Protocol TCP -LocalPort @(5432, 8888, 8186) -Profile Any
    # Allow rules for node.exe created elsewhere (e.g. by a firewall prompt) would open the HMI to every network.
    $others = @(Get-NetFirewallApplicationFilter -Program $NodeExe -ErrorAction SilentlyContinue | Get-NetFirewallRule -ErrorAction SilentlyContinue |
        Where-Object { $_.Group -ne $AhwrFirewallGroup -and $_.Direction -eq 'Inbound' })
    foreach ($rule in $others) { Remove-NetFirewallRule -Name $rule.Name }
    return $others.Count
}

function Set-EdgePowerPlan {
    $ErrorActionPreference = 'Continue'   # native tools write notices to stderr
    & powercfg.exe /setactive SCHEME_MIN 2>$null | Out-Null   # High performance
    & powercfg.exe /change standby-timeout-ac 0 | Out-Null
    & powercfg.exe /change hibernate-timeout-ac 0 | Out-Null
    & powercfg.exe /hibernate off 2>$null | Out-Null
}

function Get-TimeSyncState {
    $ErrorActionPreference = 'Continue'   # native tools write notices to stderr
    $text = (& w32tm.exe /query /status 2>&1 | Out-String)
    $source = ''
    if ($text -match '(?m)^Source:\s*(.+)$') { $source = $matches[1].Trim() }
    $synced = [bool]($source -and $source -notmatch 'Local CMOS Clock|Free-running')
    return [pscustomobject]@{ Synced = $synced; Source = $source; TimeZone = (Get-TimeZone).Id }
}

# --- Database and self-test --------------------------------------------------------------------------------
function Invoke-EdgeSql([string]$Root, $Settings, [string]$Sql, [switch]$AsSuperuser, [string]$Database = '') {
    $ErrorActionPreference = 'Continue'   # native tools write notices to stderr
    $psql = Join-Parts $Root 'runtime' 'pgsql' 'bin' 'psql.exe'
    $user = $Settings['PGUSER']; $password = $Settings['PGPASSWORD']
    if ($AsSuperuser) { $user = 'postgres'; $password = $Settings['PG_SUPERUSER_PASSWORD'] }
    if (-not $Database) { $Database = $Settings['PGDATABASE'] }
    $old = $env:PGPASSWORD
    $env:PGPASSWORD = $password
    try {
        $out = & $psql -X -q -t -A -h 127.0.0.1 -p $Settings['PGPORT'] -U $user -d $Database -v ON_ERROR_STOP=1 -c $Sql 2>&1
        if ($LASTEXITCODE -ne 0) { throw ('psql: ' + (($out | Out-String).Trim())) }
        return (($out | Out-String).Trim())
    } finally { $env:PGPASSWORD = $old }
}

function Invoke-Native([string]$FilePath, [string[]]$Arguments = @()) {
    # Run a program; its output goes to the log. Returns ExitCode and Output lines.
    $ErrorActionPreference = 'Continue'   # native tools write notices to stderr
    $out = & $FilePath @Arguments 2>&1
    $code = $LASTEXITCODE
    $lines = @($out | ForEach-Object { [string]$_ })
    foreach ($l in $lines) { Write-Log ('  | ' + $l) }
    return [pscustomobject]@{ ExitCode = $code; Output = $lines }
}

function Wait-HttpOk([string]$Url, [int]$Seconds = 60) {
    for ($i = 0; $i -lt $Seconds; $i++) {
        try { $null = Invoke-RestMethod -Uri $Url -TimeoutSec 3; return $true } catch { Start-Sleep -Seconds 1 }
    }
    return $false
}

function Invoke-SelfTest([string]$Root) {
    $settings = Read-EnvFile (Join-Path $Root 'settings.env')
    foreach ($name in $AhwrServices) {
        $svc = Get-CimInstance Win32_Service -Filter "Name='$name'" -ErrorAction SilentlyContinue
        if (-not $svc) { Add-Check "Service $name" 'FAILED' 'not installed'; continue }
        if ($svc.State -ne 'Running') { Add-Check "Service $name" 'FAILED' "$($svc.State); see logs\$name.log" }
        elseif ($svc.StartMode -ne 'Auto') { Add-Check "Service $name" 'WARNING' "running, but starts $($svc.StartMode)" }
        else { Add-Check "Service $name" 'OK' 'running, starts automatically' }
    }
    try {
        $version = Invoke-EdgeSql $Root $settings "SELECT current_setting('server_version') || ' + TimescaleDB ' || extversion FROM pg_extension WHERE extname = 'timescaledb'"
        if ($version) { Add-Check 'Database' 'OK' "PostgreSQL $version" } else { Add-Check 'Database' 'FAILED' 'TimescaleDB extension missing in ahwr_edge' }
    } catch { Add-Check 'Database' 'FAILED' $_.Exception.Message }
    try {
        $row = Invoke-EdgeSql $Root $settings "SELECT count(*) || '|' || count(DISTINCT metric) FROM telemetry WHERE ts > now() - interval '2 minutes'"
        $parts = $row.Split('|')
        if ([int]$parts[0] -gt 0) { Add-Check 'PLC readings' 'OK' "$($parts[0]) readings from $($parts[1]) channels in the last 2 minutes" }
        else { Add-Check 'PLC readings' 'WARNING' 'none in the last 2 minutes: map the tags (Settings > PLC config) and check the PLC link' }
    } catch { Add-Check 'PLC readings' 'WARNING' $_.Exception.Message }
    $port = 8080
    if ($settings.Contains('PORT') -and $settings['PORT']) { $port = [int]$settings['PORT'] }
    if (Wait-HttpOk "http://127.0.0.1:$port/healthz" 30) { Add-Check 'Web UI' 'OK' "answers on port $port" }
    else { Add-Check 'Web UI' 'FAILED' "no answer on http://127.0.0.1:$port/healthz; see logs\AHWR-Backend.log" }
    $rules = @(Get-NetFirewallRule -Group $AhwrFirewallGroup -ErrorAction SilentlyContinue)
    if ($rules.Count -ge 2) { Add-Check 'Firewall' 'OK' 'HMI open to the rig LAN only; database and collector ports closed' }
    else { Add-Check 'Firewall' 'WARNING' 'AHWR-EDGE firewall rules missing: run Apply-Settings.bat' }
    if (Get-ScheduledTask -TaskName 'AHWR-EDGE records backup' -ErrorAction SilentlyContinue) { Add-Check 'Daily backup' 'OK' 'scheduled at 02:30' }
    else { Add-Check 'Daily backup' 'WARNING' 'scheduled task missing' }
    if ($settings['SYNC_ENABLED'] -eq 'true') {
        try {
            $state = Invoke-EdgeSql $Root $settings "SELECT coalesce(body->>'ackedBatches','0') || '|' || to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || '|' || (updated_at > now() - interval '10 minutes')::text FROM app.documents WHERE name = 'sync_state.json'"
            $buffer = @(Get-ChildItem -LiteralPath (Join-Parts $Root 'data' 'app' 'sync_buffer') -Filter 'batch-*.json.gz' -ErrorAction SilentlyContinue).Count
            if (-not $state) { Add-Check 'Upload to CMF' 'WARNING' "no batch acknowledged yet; $buffer batch(es) waiting" }
            else {
                $p = $state.Split('|')
                if ([int]$p[0] -gt 0 -and $p[2] -eq 'true') { Add-Check 'Upload to CMF' 'OK' "$($p[0]) batches acknowledged, last at $($p[1]) UTC; $buffer waiting" }
                else { Add-Check 'Upload to CMF' 'WARNING' "$($p[0]) batches acknowledged, last change $($p[1]) UTC; $buffer waiting. See Edge Sync in the web UI." }
            }
        } catch { Add-Check 'Upload to CMF' 'WARNING' $_.Exception.Message }
    } else { Add-Check 'Upload to CMF' 'INFO' 'off until CentralUrl and DeviceToken are set (Apply-Settings.bat)' }
    try {
        $t = Get-TimeSyncState
        if ($t.Synced -and $t.TimeZone -eq 'India Standard Time') { Add-Check 'Time' 'OK' "synchronised with $($t.Source), $($t.TimeZone)" }
        else { Add-Check 'Time' 'WARNING' "source '$($t.Source)', time zone $($t.TimeZone): use the domain/NTP time source and India Standard Time" }
    } catch { Add-Check 'Time' 'WARNING' $_.Exception.Message }
}

# --- Service helpers -----------------------------------------------------------------------------------
function Stop-AhwrServices([string[]]$Names) {
    foreach ($name in $Names) {
        $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
        if ($svc -and $svc.Status -ne 'Stopped') {
            Stop-Service -Name $name -Force -ErrorAction Stop
            $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60))
        }
    }
}

function Start-AhwrServices([string[]]$Names) {
    foreach ($name in $Names) {
        $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
        if ($svc -and $svc.Status -ne 'Running') {
            Start-Service -Name $name -ErrorAction Stop
            $svc.WaitForStatus('Running', [TimeSpan]::FromSeconds(60))
        }
    }
}

function Invoke-EdgeScript([string]$ScriptPath, [string[]]$Arguments = @(), [hashtable]$Environment = @{}) {
    # Run one of the edge's own scripts in a child Windows PowerShell; its output goes to the log.
    $ErrorActionPreference = 'Continue'   # native tools write notices to stderr
    $saved = @{}
    foreach ($k in $Environment.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process'); [Environment]::SetEnvironmentVariable($k, $Environment[$k], 'Process') }
    try {
        $output = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ScriptPath @Arguments 2>&1
        $code = $LASTEXITCODE
    } finally {
        foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
    }
    foreach ($line in @($output)) { Write-Log ('  | ' + [string]$line) }
    if ($code -ne 0) {
        $tail = (@($output) | Select-Object -Last 4 | ForEach-Object { [string]$_ }) -join ' '
        throw "$(Split-Path -Leaf $ScriptPath) failed (exit $code): $tail"
    }
}

function Read-InstallInfo([string]$Root) {
    $path = Join-Parts $Root 'config' 'install.json'
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    return (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json)
}

Export-ModuleMember -Function * -Variable AhwrServices, AhwrPorts, AhwrFirewallGroup, AhwrSecretIniKeys, RigIdPattern
