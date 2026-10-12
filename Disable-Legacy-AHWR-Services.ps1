param(
    [Parameter(Mandatory = $true)]
    [string]$CurrentRoot
)

$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'This cleanup must run as Administrator.'
}

$CurrentRoot = [IO.Path]::GetFullPath($CurrentRoot).TrimEnd('\')
$legacyNames = @('AHWR-Dashboard', 'AHWR-InfluxDB', 'AHWR-Telegraf')
$changed = @()

foreach ($name in $legacyNames) {
    $service = Get-CimInstance Win32_Service -Filter "Name='$name'" -ErrorAction SilentlyContinue
    if (-not $service) { continue }

    $servicePath = [string]$service.PathName
    $isCurrentInstall = $servicePath.IndexOf($CurrentRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
    if ($isCurrentInstall) {
        Write-Host "Keeping current-install service $name." -ForegroundColor Green
        continue
    }

    if ($service.State -ne 'Stopped') {
        Stop-Service -Name $name -Force -ErrorAction Stop
        (Get-Service -Name $name).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(20))
    }
    Set-Service -Name $name -StartupType Manual -ErrorAction Stop
    $changed += "$name [$servicePath]"
    Write-Host "Stopped legacy service and set Manual startup: $name" -ForegroundColor Yellow
}

$logDir = Join-Path $CurrentRoot 'logs'
$null = New-Item -ItemType Directory -Force -Path $logDir
$logPath = Join-Path $logDir 'legacy-service-cleanup.log'
@(
    "Timestamp: $(Get-Date -Format o)"
    "Current installation: $CurrentRoot"
    if ($changed.Count) { 'Changed services:'; $changed } else { 'No legacy services required changes.' }
) | Set-Content -LiteralPath $logPath -Encoding UTF8

Write-Host 'Legacy AHWR service cleanup completed.' -ForegroundColor Green

