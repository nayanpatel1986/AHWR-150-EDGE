@echo off
rem AHWR-150 EDGE: installs everything (database, collector, application, services). Fill in rig-settings.ini first.
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\Install.ps1" 
echo.
pause
