@echo off
rem AHWR-150 EDGE: backs up the operating records now.
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\Backup-Now.ps1" 
echo.
pause
