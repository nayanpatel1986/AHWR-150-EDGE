# Installs a newer released version over an installed edge, run from the NEW
# installer folder (Update.bat). Backs up the records, stops the collector and
# the application (the database keeps running), replaces the programs, applies
# schema upgrades, self-tests, and puts the previous version back by itself if
# anything fails. Data, settings and the PLC map are kept. Windows PowerShell 5.1.
param([switch]$PauseAtEnd)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$SetupDir = $PSScriptRoot
$PackageRoot = Split-Path -Parent $SetupDir
Import-Module (Join-Path $SetupDir 'AhwrSetup.psm1') -Force -DisableNameChecking
if (-not (Test-IsAdministrator)) { Restart-Elevated $PSCommandPath }

$Total = 5
$Root = Get-AhwrInstallRoot
$NewVersion = (Get-Content -LiteralPath (Join-Path $PackageRoot 'VERSION.txt') -Raw).Trim()
$ComponentsDir = Join-Path $PackageRoot 'components'
$AppSource = Join-Path $PackageRoot 'app'
$Components = @{}
foreach ($c in (Read-ComponentManifest (Join-Path $ComponentsDir 'components.json'))) { $Components[$c.name] = $c }
$AppServices = @('AHWR-BOP-Collector', 'AHWR-Backend', 'AHWR-Telegraf')
$journal = New-Object System.Collections.ArrayList     # moves to undo: @{ Original; Saved }
$state = @{ OldVersion = '?'; Rollback = $null; Changed = $false; PgReplaced = $false }

function Save-ForRollback([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $rel = $Path.Substring($Root.TrimEnd('\').Length).TrimStart('\')
    $dest = Join-Path $state.Rollback $rel
    $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest)
    Move-Item -LiteralPath $Path -Destination $dest
    $null = $journal.Add(@{ Original = $Path; Saved = $dest })
}

function Test-ComponentChanged([string]$Name, [string]$Marker) {
    $installed = Get-InstalledComponents $Root
    return -not ($installed.ContainsKey($Name) -and $installed[$Name] -eq $Marker)
}

function Invoke-Rollback {
    Write-Host ''
    Write-Host 'Putting the previous version back...' -ForegroundColor Yellow
    try { Stop-AhwrServices $AppServices } catch { Write-Log "rollback: stop: $($_.Exception.Message)" }
    if ($state.PgReplaced) { try { Stop-AhwrServices @('AHWR-PostgreSQL') } catch { Write-Log "rollback: stop db: $($_.Exception.Message)" } }
    for ($i = $journal.Count - 1; $i -ge 0; $i--) {
        $j = $journal[$i]
        if (Test-Path -LiteralPath $j.Original) { Remove-Item -LiteralPath $j.Original -Recurse -Force }
        Move-Item -LiteralPath $j.Saved -Destination $j.Original
    }
    Start-AhwrServices @('AHWR-PostgreSQL', 'AHWR-Telegraf', 'AHWR-Backend', 'AHWR-BOP-Collector')
    if (Wait-HttpOk 'http://127.0.0.1:8080/healthz' 90) { Add-Check 'Rollback' 'OK' "version $($state.OldVersion) restored and running" }
    else { Add-Check 'Rollback' 'FAILED' "version $($state.OldVersion) restored but the web UI does not answer: run Check-Health.bat" }
}

$code = 1
$outcome = 'UPDATE FAILED'
try {
    if (-not (Test-Path -LiteralPath (Join-Path $Root 'settings.env'))) { throw "AHWR-EDGE is not installed in ${Root}: use Install.bat." }
    Set-SetupLog (Join-Parts $Root 'logs' 'update.log')
    $info = Read-InstallInfo $Root
    if ($info) { $state.OldVersion = $info.version }
    Write-Host "AHWR-150 EDGE update $($state.OldVersion) -> $NewVersion" -ForegroundColor Cyan

    Invoke-Stage 1 $Total 'Checks' {
        $problems = @(Get-PackageChecksumProblems $PackageRoot)
        if ($problems.Count) { Add-Check 'Installer files' 'FAILED' ("$($problems.Count) file(s) damaged or changed (" + (($problems | Select-Object -First 3) -join '; ') + ')') }
        else { Add-Check 'Installer files' 'OK' 'all checksums match' }
        foreach ($name in $AhwrServices) { if (-not (Get-Service -Name $name -ErrorAction SilentlyContinue)) { Add-Check $name 'FAILED' 'not installed: use Install.bat to repair first' } }
        if ($state.OldVersion -eq $NewVersion) { Add-Check 'Version' 'WARNING' "$NewVersion is already installed; installing it again" }
        else { Add-Check 'Version' 'OK' "$($state.OldVersion) -> $NewVersion" }
        $pg = $Components['pgsql']
        $installedPg = Join-Parts $Root 'runtime' 'pgsql' 'bin' 'postgres.exe'
        if ((Test-Path -LiteralPath $installedPg) -and $pg.version) {
            $have = ((Invoke-Native $installedPg @('--version')).Output -join ' ')
            if ($have -match '(\d+)\.\d+' -and $matches[1] -ne $pg.version.Split('.')[0]) {
                Add-Check 'PostgreSQL' 'FAILED' "installed major version $($matches[1]), new $($pg.version): a major upgrade needs a dump and restore, which Update.bat does not do"
            }
        }
    }
    Invoke-Stage 2 $Total 'Backup' {
        $start = Get-Date
        Invoke-EdgeScript (Join-Path $Root 'Backup-AHWR-EDGE-Records.ps1')
        $latest = Get-ChildItem -LiteralPath (Join-Path $Root 'backups') -Filter 'records-*.dump' | Where-Object { $_.LastWriteTime -ge $start.AddSeconds(-5) } | Select-Object -First 1
        if (-not $latest) { throw 'the records backup was not written' }
        Add-Check 'Records backup' 'OK' $latest.FullName
    }
    $state.Rollback = Join-Parts $Root 'rollback' ('{0}-{1:yyyyMMdd-HHmmss}' -f $state.OldVersion, (Get-Date))
    Invoke-Stage 3 $Total 'Install' {
        $state.Changed = $true
        Stop-AhwrServices $AppServices
        Add-Check 'Collector and application' 'OK' 'stopped; the database keeps running'
        $null = New-Item -ItemType Directory -Force -Path $state.Rollback
        Copy-Item -LiteralPath (Join-Parts $Root 'runtime' 'components.json') -Destination $state.Rollback -ErrorAction SilentlyContinue

        $pg = $Components['pgsql']; $ts = $Components['timescaledb']
        if (Test-ComponentChanged 'pgsql' "$($pg.sha256)+$($ts.sha256)") {
            Stop-AhwrServices @('AHWR-PostgreSQL')
            $state.PgReplaced = $true
            $pgDir = Join-Parts $Root 'runtime' 'pgsql'
            $tmp = "$pgDir.new"
            if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
            Expand-ZipTo (Join-Path $ComponentsDir $pg.file) $tmp $pg.strip @('pgAdmin 4/', 'StackBuilder/', 'doc/', 'include/')
            $tsTmp = Join-Parts $Root 'run' 'timescaledb.new'
            if (Test-Path -LiteralPath $tsTmp) { Remove-Item -LiteralPath $tsTmp -Recurse -Force }
            Expand-ZipTo (Join-Path $ComponentsDir $ts.file) $tsTmp $ts.strip
            Copy-Item -Path (Join-Path $tsTmp '*.dll') -Destination (Join-Path $tmp 'lib') -Force
            Copy-Item -Path (Join-Path $tsTmp 'timescaledb.control') -Destination (Join-Parts $tmp 'share' 'extension') -Force
            Copy-Item -Path (Join-Path $tsTmp 'timescaledb--*.sql') -Destination (Join-Parts $tmp 'share' 'extension') -Force
            Remove-Item -LiteralPath $tsTmp -Recurse -Force
            Save-ForRollback $pgDir
            Rename-Item -LiteralPath $tmp -NewName 'pgsql'
            Set-InstalledComponent $Root 'pgsql' "$($pg.sha256)+$($ts.sha256)"
            Start-AhwrServices @('AHWR-PostgreSQL')
            Add-Check 'PostgreSQL + TimescaleDB' 'OK' "PostgreSQL $($pg.version), TimescaleDB $($ts.version)"
        }
        foreach ($name in @('telegraf', 'node', 'nssm')) {
            $c = $Components[$name]
            if (-not (Test-ComponentChanged $name $c.sha256)) { continue }
            $target = Join-Parts $Root 'runtime' $name
            $tmp = "$target.new"
            if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
            $only = @()
            if ($name -eq 'nssm') { $only = @('nssm.exe') }
            Expand-ZipTo (Join-Path $ComponentsDir $c.file) $tmp $c.strip @() $only
            Save-ForRollback $target
            Rename-Item -LiteralPath $tmp -NewName $name
            Set-InstalledComponent $Root $name $c.sha256
            Add-Check $name 'OK' "version $($c.version)"
        }
        $py = $Components['python']; $wheels = $Components['python-wheels']
        if (Test-ComponentChanged 'python' "$($py.sha256)+$($wheels.sha256)") {
            $target = Join-Parts $Root 'runtime' 'python'
            $tmp = "$target.new"
            if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
            Install-PythonEmbedded (Join-Path $ComponentsDir $py.file) (Join-Path $ComponentsDir $wheels.dir) $tmp
            Save-ForRollback $target
            Rename-Item -LiteralPath $tmp -NewName 'python'
            Set-InstalledComponent $Root 'python' "$($py.sha256)+$($wheels.sha256)"
            Add-Check 'python' 'OK' "version $($py.version)"
        }

        # The application and the scripts: everything from the package except data and runtime.
        $servicesScriptBefore = (Get-FileHash -LiteralPath (Join-Path $Root 'Install-AHWR-EDGE-Services.ps1')).Hash
        foreach ($item in @(Get-ChildItem -LiteralPath $AppSource -Force)) {
            if ($item.Name -in @('data', 'logs', 'backups', 'run', 'runtime', 'config', 'certs', 'tools', 'settings.env')) { continue }
            Save-ForRollback (Join-Path $Root $item.Name)
        }
        $exclude = @('data', 'logs', 'backups', 'run', 'runtime', 'config', 'certs', 'tools') | ForEach-Object { Join-Path $AppSource $_ }
        $r = Invoke-Native 'robocopy.exe' (@($AppSource, $Root, '/E', '/R:2', '/W:2', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/XF', 'settings.env', '/XD') + $exclude)
        if ($r.ExitCode -ge 8) { throw "copying the application failed (robocopy $($r.ExitCode))" }
        # The generated Telegraf PLC config belongs to this rig: keep it.
        $plcConf = @($journal | Where-Object { $_.Original -ieq (Join-Path $Root 'app') })
        if ($plcConf.Count) {
            $oldConf = Join-Parts $plcConf[0].Saved 'telegraf' 'telegraf.d' 'plc.conf'
            if (Test-Path -LiteralPath $oldConf) { Copy-Item -LiteralPath $oldConf -Destination (Join-Parts $Root 'app' 'telegraf' 'telegraf.d') -Force }
        }
        Add-Check 'Edge application' 'OK' "version $NewVersion copied"
        $state.ServicesScriptChanged = ($servicesScriptBefore -ne (Get-FileHash -LiteralPath (Join-Path $Root 'Install-AHWR-EDGE-Services.ps1')).Hash)
    }
    Invoke-Stage 4 $Total 'Start' {
        if ($state.ServicesScriptChanged -or (Test-ComponentChanged 'nssm' $Components['nssm'].sha256)) {
            Invoke-EdgeScript (Join-Path $Root 'Install-AHWR-EDGE-Services.ps1') @('-NssmPath', (Join-Parts $Root 'runtime' 'nssm' 'nssm.exe'), '-BackupTime', '02:30')
            Add-Check 'Services' 'OK' 'registered again (service definitions changed)'
        }
        # Applies the schema upgrades and starts the services (service mode).
        Invoke-EdgeScript (Join-Path $Root 'Start-AHWR-EDGE.ps1') @() @{ AHWR_NO_BROWSER = '1' }
        Add-Check 'Start' 'OK' 'schema upgraded, services started, web UI answers'
    }
    Invoke-Stage 5 $Total 'Self-test' { Invoke-SelfTest $Root }

    # Done: refresh the tools and the install record; keep only this rollback copy.
    $tools = Join-Path $Root 'tools'
    foreach ($bat in @('Apply-Settings.bat', 'Check-Health.bat', 'Backup-Now.bat', 'Restore-Records.bat', 'Collect-Logs.bat', 'Uninstall.bat')) { Copy-Item -LiteralPath (Join-Path $PackageRoot $bat) -Destination $tools -Force }
    Copy-Item -Path (Join-Path $SetupDir '*') -Destination (Join-Path $tools 'setup') -Force
    Copy-Item -LiteralPath (Join-Path $PackageRoot 'VERSION.txt') -Destination $tools -Force
    $record = [ordered]@{ version = $NewVersion; deviceId = ''; dataRoot = ''; installedAt = ''; updatedAt = (Get-Date).ToString('o'); previousVersion = $state.OldVersion; package = $PackageRoot }
    if ($info) { $record.deviceId = $info.deviceId; $record.dataRoot = $info.dataRoot; $record.installedAt = $info.installedAt }
    Write-Utf8File (Join-Parts $Root 'config' 'install.json') @(($record | ConvertTo-Json))
    Get-ChildItem -LiteralPath (Join-Path $Root 'rollback') -Directory | Where-Object { $_.FullName -ne $state.Rollback } | Remove-Item -Recurse -Force
    $outcome = 'UPDATE SUCCESSFUL'
    $code = 0
} catch {
    Write-Host ''
    Write-Host $_.Exception.Message -ForegroundColor Red
    if ($state.Changed) {
        try { Invoke-Rollback; $outcome = "UPDATE FAILED - version $($state.OldVersion) restored" }
        catch { $outcome = 'UPDATE FAILED - ROLLBACK FAILED'; Write-Host "Rollback failed: $($_.Exception.Message). The previous files are in $($state.Rollback)." -ForegroundColor Red }
    }
} finally {
    $report = Join-Parts $Root 'logs' ('update-{0:yyyyMMdd-HHmmss}.html' -f (Get-Date))
    if (Test-Path -LiteralPath (Join-Path $Root 'logs')) {
        Write-SetupReport $report 'AHWR-150 EDGE update' $outcome ([ordered]@{ 'From' = $state.OldVersion; 'To' = $NewVersion; 'Computer' = $env:COMPUTERNAME })
        Write-Host "Report: $report"
    }
    Write-Host ''
    $color = 'Red'
    if ($code -eq 0) { $color = 'Green' }
    Write-Host $outcome -ForegroundColor $color
    if ($PauseAtEnd) { $null = Read-Host 'Press Enter to close this window' }
}
exit $code
