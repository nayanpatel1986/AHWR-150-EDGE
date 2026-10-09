$ErrorActionPreference = 'Stop'

$Root = $PSScriptRoot
$StartBatch = Join-Path $Root 'Start-AHWR-EDGE.bat'
$Icon = Join-Path $Root 'assets\ahwr-edge.ico'
if (-not (Test-Path -LiteralPath $StartBatch)) {
    throw "Missing start file: $StartBatch"
}

$StartupDir = [Environment]::GetFolderPath('Startup')
$ShortcutPath = Join-Path $StartupDir 'AHWR-EDGE.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($ShortcutPath)
$shortcut.TargetPath = $StartBatch
$shortcut.WorkingDirectory = $Root
if (Test-Path -LiteralPath $Icon) {
    $shortcut.IconLocation = $Icon
}
$shortcut.WindowStyle = 7
$shortcut.Description = 'Start AHWR-EDGE and open the local dashboard'
$shortcut.Save()

Write-Host "AHWR-EDGE will start automatically when this Windows user logs in." -ForegroundColor Green
Write-Host "Startup shortcut: $ShortcutPath"
