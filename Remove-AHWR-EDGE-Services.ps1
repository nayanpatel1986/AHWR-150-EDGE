param([string]$NssmPath)
$ErrorActionPreference = 'Stop'
# Removes the AHWR-EDGE Windows services and the records-backup task. Data in
# data\ (database, records) is kept; Start-AHWR-EDGE.bat runs the portable
# processes again afterwards.
$Root = $PSScriptRoot
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this script in an elevated (Administrator) PowerShell.' }
if (-not $NssmPath) {
    $NssmPath = @((Join-Path $Root 'runtime\nssm\nssm.exe'), (Join-Path $Root 'tools\nssm.exe')) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
foreach ($name in @('AHWR-BOP-Collector', 'AHWR-Backend', 'AHWR-Telegraf')) {
    if (Get-Service $name -ErrorAction SilentlyContinue) {
        if (-not $NssmPath) { throw 'nssm.exe not found; pass -NssmPath.' }
        & $NssmPath stop $name | Out-Null
        & $NssmPath remove $name confirm | Out-Null
        Write-Host "Removed $name."
    }
}
if (Get-Service 'AHWR-PostgreSQL' -ErrorAction SilentlyContinue) {
    Stop-Service 'AHWR-PostgreSQL' -ErrorAction SilentlyContinue
    & (Join-Path $Root 'runtime\pgsql\bin\pg_ctl.exe') unregister -N 'AHWR-PostgreSQL' | Out-Null
    Write-Host 'Removed AHWR-PostgreSQL (data\pgdata kept).'
}
Unregister-ScheduledTask -TaskName 'AHWR-EDGE records backup' -Confirm:$false -ErrorAction SilentlyContinue
Write-Host 'AHWR-EDGE services removed. Use Start-AHWR-EDGE.bat to run the portable processes.' -ForegroundColor Green
