$ErrorActionPreference = 'Stop'

$StartupDir = [Environment]::GetFolderPath('Startup')
$ShortcutPath = Join-Path $StartupDir 'AHWR-EDGE.lnk'

if (Test-Path -LiteralPath $ShortcutPath) {
    Remove-Item -LiteralPath $ShortcutPath -Force
    Write-Host 'Removed AHWR-EDGE automatic startup shortcut.' -ForegroundColor Green
} else {
    Write-Host 'AHWR-EDGE automatic startup shortcut was not found.'
}
