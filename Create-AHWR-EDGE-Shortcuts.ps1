param(
    [switch]$Desktop
)

$ErrorActionPreference = 'Stop'

$Root = $PSScriptRoot
$Icon = Join-Path $Root 'assets\ahwr-edge.ico'
$StartBatch = Join-Path $Root 'Start-AHWR-EDGE.bat'
$StopBatch = Join-Path $Root 'Stop-AHWR-EDGE.bat'

foreach ($path in @($Icon, $StartBatch, $StopBatch)) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Missing required file: $path"
    }
}

$shell = New-Object -ComObject WScript.Shell

function New-EdgeShortcut([string]$Name, [string]$Target, [string]$Description, [string]$Folder) {
    $shortcutPath = Join-Path $Folder "$Name.lnk"
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $Target
    $shortcut.WorkingDirectory = $Root
    $shortcut.IconLocation = $Icon
    $shortcut.WindowStyle = 7
    $shortcut.Description = $Description
    $shortcut.Save()
    Write-Host "Created $shortcutPath"
}

New-EdgeShortcut 'Start AHWR-EDGE' $StartBatch 'Start AHWR-EDGE and open the dashboard' $Root
New-EdgeShortcut 'Stop AHWR-EDGE' $StopBatch 'Stop AHWR-EDGE services' $Root

if ($Desktop) {
    $desktopDir = [Environment]::GetFolderPath('Desktop')
    New-EdgeShortcut 'Start AHWR-EDGE' $StartBatch 'Start AHWR-EDGE and open the dashboard' $desktopDir
    New-EdgeShortcut 'Stop AHWR-EDGE' $StopBatch 'Stop AHWR-EDGE services' $desktopDir
}

Write-Host 'AHWR-EDGE shortcuts are ready.' -ForegroundColor Green
