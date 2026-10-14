@echo off
rem AHWR-150 EDGE: restores a records backup. Usage: Restore-Records.bat <backup file>
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\Restore-Records.ps1" %*
echo.
pause
