@echo off
rem AHWR-150 EDGE: re-applies rig-settings.ini after a change (token, domain, subnet).
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\Apply-Settings.ps1" 
echo.
pause
